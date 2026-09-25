#!/usr/bin/env node
// Imports a product catalog written by export-catalog.mjs into a MonetizeNow tenant.
//
// Nothing that already exists in the target tenant is changed. Each record in the export is first matched against
// the target's catalog (same custom ID, or else same name and type) and reused when it matches; only records with
// no match are created. Progress is saved after every record, so a run that stops part-way can simply be run again.

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_API_URL,
  EXPORT_FORMAT_VERSION,
  OUTPUT_DIR,
  RUN_STAMP,
  assertNodeVersion,
  compact,
  confirm,
  createApiClient,
  errorMessage,
  fail,
  fingerprint,
  loadEnvFile,
  log,
  maskSecret,
  nonEmpty,
  openLogFile,
  parseFlags,
  readJson,
  requireEnv,
  writeCsv,
  writeJson,
} from './lib.mjs';

const HELP = `
Usage: node import-catalog.mjs [--file <export.json>] [--dry-run] [--yes] [--restart]

Imports a catalog export into the tenant that TARGET_API_KEY belongs to. Records that already exist in the target
(same custom ID, or same name and type) are reused, not duplicated, and are never modified.

  --file <file>  Export file to import (default: output/catalog-export.json)
  --dry-run      Check the export against the target tenant and report what would be created or reused,
                 without changing anything
  --yes          Skip the confirmation prompt
  --restart      Ignore progress saved by an earlier run against this tenant and match every record again
  --help         Show this message

Environment (or .env):
  TARGET_API_KEY   API key for the tenant to import into (required)
  TARGET_API_URL   API base URL (default: ${DEFAULT_API_URL})
`;

const KINDS = ['usageType', 'bucket', 'product', 'offering', 'rate'];
const LABELS = { usageType: 'Usage type', bucket: 'Credit bucket', product: 'Product', offering: 'Offering', rate: 'Rate' };
const RESULT = {
  created: 'Created',
  matched: 'Matched existing',
  earlierCreated: 'Created in an earlier run',
  earlierMatched: 'Matched in an earlier run',
  wouldCreate: 'Would create',
  wouldMatch: 'Would match existing',
  skipped: 'Skipped',
  failed: 'Failed',
};
const REPORT_COLUMNS = ['Record', 'Name', 'Offering', 'Type', 'Status', 'Result', 'Details', 'Source ID', 'Target ID'];
const CUSTOM_FIELD_ENTITY = { product: 'PRODUCT', offering: 'OFFERING', rate: 'RATE' };

assertNodeVersion();
loadEnvFile();
const flags = parseFlags(process.argv.slice(2), {
  file: 'string',
  'dry-run': 'boolean',
  yes: 'boolean',
  restart: 'boolean',
  help: 'boolean',
});
if (flags.help) {
  console.log(HELP);
  process.exit(0);
}

const dryRun = Boolean(flags['dry-run']);
const apiKey = requireEnv('TARGET_API_KEY');
const api = createApiClient({ apiUrl: process.env.TARGET_API_URL?.trim() || DEFAULT_API_URL, apiKey });
const inputFile = resolve(flags.file ?? join(OUTPUT_DIR, 'catalog-export.json'));
const stateFile = join(OUTPUT_DIR, `import-state-${fingerprint(apiKey)}.json`);
const reportFile = join(OUTPUT_DIR, `import-${dryRun ? 'dry-run-' : ''}report-${RUN_STAMP}.csv`);
const requestsFile = join(OUTPUT_DIR, `import-dry-run-requests-${RUN_STAMP}.json`);

/** Thrown while importing a record that cannot be imported because something it depends on was not imported. */
class SkipRecord extends Error {}
/** Thrown when the target has a record that looks like this one but cannot safely be reused. */
class Conflict extends Error {}

const rows = new Map(); // `${kind}:${sourceId}` -> report row, in import order
const warnings = [];
const dryRunRequests = [];
const claimed = new Set(); // target IDs already paired with a source record, so none is reused twice
const missingCustomFields = { PRODUCT: new Set(), OFFERING: new Set(), RATE: new Set() };
let state;
let existing; // the target tenant's catalog as it was before this run

async function main() {
  const logFile = openLogFile(dryRun ? 'import-dry-run' : 'import');
  const catalog = loadExport(inputFile);
  const { summary } = catalog;

  log.info(`Export file:  ${inputFile}`);
  log.info(`  exported ${catalog.exportedAt} from ${catalog.source?.apiUrl ?? 'unknown'}`);
  log.info(
    `  ${summary.usageTypes} usage types, ${summary.buckets} credit buckets, ${summary.products} products, ` +
      `${summary.offerings} offerings, ${summary.rates} rates`,
  );
  log.info(`Target:       ${api.apiUrl} (API key ${maskSecret(apiKey)})`);
  if (dryRun) log.info('Mode:         dry run, nothing will be changed');

  state = loadState(catalog);
  const earlier = KINDS.reduce((total, kind) => total + Object.keys(state.records[kind]).length, 0);
  if (earlier) log.info(`Resuming:     ${earlier} record(s) were imported by an earlier run`);
  for (const kind of KINDS) for (const { targetId } of Object.values(state.records[kind])) claimed.add(targetId);

  const problems = await checkTarget(catalog);
  if (problems.length) {
    log.step('Problems that must be fixed before importing');
    problems.forEach((problem) => log.error(problem));
    if (!dryRun) fail('Fix the problems above and run the import again.');
    process.exitCode = 1;
  }

  if (!dryRun && !flags.yes) {
    const proceed = await confirm(`\nImport into ${api.apiUrl}? Existing records are reused and never changed.`);
    if (!proceed) fail('Import cancelled.');
    log.info('Confirmed.');
  }

  const productsOnOfferings = new Set(
    catalog.offerings.flatMap((offering) => offering.offeringProducts.map((op) => op.product.id)),
  );
  const offeringsById = new Map(catalog.offerings.map((offering) => [offering.id, offering]));
  const ratesByOffering = new Map(
    catalog.offerings.map((offering) => [offering.id, catalog.rates.filter((rate) => rate.offering?.id === offering.id)]),
  );
  const customIds = (records) => new Set(records.map((record) => nonEmpty(record.customId)).filter(Boolean));
  const reserved = {
    products: customIds(catalog.products),
    offerings: customIds(catalog.offerings),
    ratesByOffering: new Map([...ratesByOffering].map(([offeringId, rates]) => [offeringId, customIds(rates)])),
  };

  log.step('Usage types');
  for (const usageType of catalog.usageTypes) {
    await importRecord('usageType', usageType, {
      row: { Type: `unit: ${usageType.unitName}`, Status: usageType.status },
      find: () =>
        findExisting('usageType', usageType, existing.usageTypes, {
          shape: (u) => `${u.unitName}|${u.decimalPlaces}`,
          describe: (u) => `measured in "${u.unitName}" with ${u.decimalPlaces} decimal places`,
          details: (u) => fieldsKey(u, ['pluralName', 'description']),
          siblings: catalog.usageTypes,
        }),
      build: () => ({
        path: '/api/usageTypes',
        body: compact({
          name: usageType.name,
          pluralName: usageType.pluralName,
          description: nonEmpty(usageType.description),
          unitName: usageType.unitName,
          decimalPlaces: usageType.decimalPlaces,
          status: usageType.status,
        }),
      }),
    });
  }

  log.step('Credit buckets');
  for (const bucket of catalog.buckets) {
    await importRecord('bucket', bucket, {
      row: { Type: bucket.type },
      find: () =>
        findExisting('bucket', bucket, existing.buckets, {
          shape: (b) => b.type,
          describe: (b) => `a bucket of type ${b.type}`,
          siblings: catalog.buckets,
        }),
      build: () => ({ path: '/api/buckets', body: { name: bucket.name, type: bucket.type } }),
    });
  }

  log.step('Products');
  for (const product of catalog.products) {
    // An offering cannot be created with an inactive product, so inactive products that belong to an exported
    // offering are created active and set back to inactive once their offerings exist.
    const createInactive = product.status === 'INACTIVE' && !productsOnOfferings.has(product.id);
    await importRecord('product', product, {
      row: { Type: product.productType, Status: product.status },
      find: () => {
        const match = findExisting('product', product, existing.products, {
          shape: (p) => p.productType,
          describe: (p) => `a product of type ${p.productType}`,
          details: (p) => fieldsKey(p, ['description', 'sku', 'financeId']),
          siblings: catalog.products,
          reservedCustomIds: reserved.products,
        });
        if (match.record && match.record.status !== product.status) {
          match.notes.push(statusDifference('product', match.record.status, product.status));
        }
        return match;
      },
      build: () => ({
        path: '/api/products',
        notes: [
          ...(createInactive || product.status !== 'INACTIVE' ? [] : ['created active; set back to inactive after its offerings']),
          ...productSettingsLeftOut(product),
        ],
        body: compact({
          name: product.name,
          description: nonEmpty(product.description),
          status: createInactive ? 'INACTIVE' : 'ACTIVE',
          productType: product.productType,
          // Settings that don't apply to the product's type are rejected; see productSettingsLeftOut.
          usageTypeIds:
            product.productType === 'USAGE' && product.usageTypes?.length
              ? product.usageTypes.map((usageType) => targetId('usageType', usageType.id, usageType.name))
              : undefined,
          oneTimePrepaidCreditConfig:
            product.productType === 'ONETIME_PREPAID_CREDIT' ? product.oneTimePrepaidCreditConfig : undefined,
          sku: nonEmpty(product.sku),
          customId: nonEmpty(product.customId),
          financeId: nonEmpty(product.financeId),
          recognitionMethod: product.recognitionMethod,
          recognitionDuration: allowsRecognitionDuration(product) ? product.recognitionDuration : undefined,
          customFields: customFields(product.customFields),
          taxItemCode: nonEmpty(product.taxItemCode),
          taxExempt: product.taxExempt,
          excludeFromRenewalUplift: product.excludeFromRenewalUplift,
          bucketId:
            product.bucket && TOKEN_PRODUCT_TYPES.includes(product.productType)
              ? targetId('bucket', product.bucket.id, product.bucket.name)
              : undefined,
          ppuDisplayPrecision: product.ppuDisplayPrecision,
          // Responses report a proration policy for every product type, but it can only be set on subscription products.
          prorationPolicy: ['ADVANCE', 'ARREARS'].includes(product.productType) ? product.prorationPolicy : undefined,
          displayUnitPriceFrequency: product.displayUnitPriceFrequency,
        }),
      }),
    });
  }

  log.step('Offerings');
  for (const offering of catalog.offerings) {
    await importRecord('offering', offering, {
      row: { Type: offering.type, Status: offering.status },
      find: () => {
        // An offering is only the same offering if it has the same products; rates could not be added to it otherwise.
        const offeringShape = (o, productId) => `${o.type}|${o.offeringProducts.map(productId).sort().join(',')}`;
        const match = findExisting('offering', offering, existing.offerings, {
          shape: (o) => offeringShape(o, (op) => op.product.id),
          sourceShape: (o) =>
            offeringShape(o, (op) => state.records.product[op.product.id]?.targetId ?? `missing:${op.product.id}`),
          describe: (o) =>
            `an offering of type ${o.type} with products ${o.offeringProducts.map((op) => `"${op.product.name}"`).join(', ') || '(none)'}`,
          details: (o) => fieldsKey(o, ['description', 'financeId']),
          siblings: catalog.offerings,
          reservedCustomIds: reserved.offerings,
        });
        if (match.record && match.record.status !== offering.status) {
          match.notes.push(statusDifference('offering', match.record.status, offering.status));
        }
        return match;
      },
      build: () => ({
        path: '/api/v2/offerings',
        notes: positionsRenumbered(offering) ? ['product positions renumbered to remove gaps, keeping their order'] : [],
        body: compact({
          customId: nonEmpty(offering.customId),
          name: offering.name,
          description: nonEmpty(offering.description),
          status: offering.status,
          startDate: offering.startDate,
          endDate: offering.endDate,
          type: offering.type,
          financeId: nonEmpty(offering.financeId),
          customFields: customFields(offering.customFields),
          offeringProducts: orderedOfferingProducts(offering).map((op, index) =>
            compact({
              productId: targetId('product', op.product.id, op.product.name),
              isMandatory: op.isMandatory ?? true,
              // Positions must run 1, 2, 3... with no gaps.
              position: index + 1,
              quantityDisplayType: op.quantityDisplayType,
              isPriceTierLockEligible: op.isPriceTierLockEligible,
            }),
          ),
        }),
      }),
    });
  }

  log.step('Rates');
  for (const rate of catalog.rates) {
    const offering = offeringsById.get(rate.offering?.id);
    await importRecord('rate', rate, {
      row: {
        Offering: offering?.name ?? rate.offering?.name,
        Type: `${rate.currency} ${rate.billingFrequency}`,
        Status: rate.status,
      },
      find: () => {
        if (rate.rateType !== 'CATALOG' || rate.status !== 'ACTIVE') {
          throw new SkipRecord('only active catalog rates are imported');
        }
        if (!offering) throw new SkipRecord('its offering is not in the export file');
        const offeringId = targetId('offering', offering.id, offering.name);
        const match = findExisting('rate', rate, existing.catalogRatesByOffering.get(offeringId) ?? [], {
          shape: (r) => `${r.currency}|${r.billingFrequency}`,
          describe: (r) => `billed ${r.billingFrequency} in ${r.currency}`,
          details: (r) => fieldsKey(r, ['description']),
          siblings: ratesByOffering.get(offering.id),
          reservedCustomIds: reserved.ratesByOffering.get(offering.id),
          // A retired rate is not reused just because it has the same name.
          nameCandidate: (r) => r.status === 'ACTIVE',
        });
        if (match.record && match.record.status !== rate.status) {
          match.notes.push(statusDifference('rate', match.record.status, rate.status));
        }
        return match;
      },
      build: () => {
        const offeringProductIds = new Set(offering.offeringProducts.map((op) => op.product.id));
        return {
          path: `/api/offerings/${targetId('offering', offering.id, offering.name)}/rates`,
          body: compact({
            rateType: 'CATALOG',
            customId: nonEmpty(rate.customId),
            name: rate.name,
            description: nonEmpty(rate.description),
            status: rate.status,
            currency: rate.currency,
            billingFrequency: rate.billingFrequency,
            billingFrequencyInMonths: rate.billingFrequencyInMonths,
            subscriptionTiming: rate.subscriptionTiming,
            usageBillingFrequency: rate.usageBillingFrequency,
            startDate: rate.startDate,
            endDate: rate.endDate,
            quotable: rate.quotable ?? false,
            internalDescription: nonEmpty(rate.internalDescription),
            prices: rate.prices.map(regularPrice),
            overagePrices: rate.overagePrices?.length ? rate.overagePrices.map(overagePrice) : undefined,
            options: rate.options ? rateOptions(rate.options, offeringProductIds) : undefined,
            minCommitConfig: rate.minCommitConfig ? withMappedProducts(rate.minCommitConfig) : undefined,
            percentOfTotalConfig: rate.percentOfTotalConfig ? withMappedProducts(rate.percentOfTotalConfig) : undefined,
            revenueChannels: rate.revenueChannels?.length ? rate.revenueChannels : undefined,
            customFields: customFields(rate.customFields),
          }),
        };
      },
    });
  }

  const toDeactivate = catalog.products.filter(
    (product) =>
      product.status === 'INACTIVE' &&
      productsOnOfferings.has(product.id) &&
      state.records.product[product.id]?.action === 'created',
  );
  if (toDeactivate.length) {
    log.step('Restoring inactive status on products');
    for (const product of toDeactivate) {
      // Wait until every offering using the product exists; a later run could not create them otherwise.
      const pending = catalog.offerings.filter(
        (offering) =>
          !state.records.offering[offering.id] && offering.offeringProducts.some((op) => op.product.id === product.id),
      );
      if (pending.length) {
        const names = pending.map((offering) => `"${offering.name}"`).join(', ');
        addDetail('product', product.id, `still active: waiting for offering ${names} to be imported`);
        warn(`product "${product.name}" (${product.id}) is left active until offering ${names} is imported`);
        continue;
      }
      await deactivateProduct(product);
    }
  }

  finish(logFile);
}

function loadExport(path) {
  if (!existsSync(path)) fail(`Export file not found: ${path}\nRun export-catalog.mjs first, or pass --file.`);
  let catalog;
  try {
    catalog = readJson(path);
  } catch (err) {
    fail(`Could not read ${path}: ${errorMessage(err)}`);
  }
  if (catalog.formatVersion !== EXPORT_FORMAT_VERSION) {
    fail(`${path} was not written by this version of export-catalog.mjs. Re-export with the same kit version.`);
  }
  for (const key of ['usageTypes', 'buckets', 'products', 'offerings', 'rates']) {
    if (!Array.isArray(catalog[key])) fail(`${path} is missing "${key}".`);
  }
  return catalog;
}

function loadState(catalog) {
  const exportId = `${catalog.source?.apiUrl}@${catalog.exportedAt}`;
  const fresh = {
    target: { apiUrl: api.apiUrl },
    exportId,
    records: Object.fromEntries(KINDS.map((kind) => [kind, {}])),
    deactivatedProducts: [],
  };
  // A dry run still reads saved progress so it shows what a real run would have left to do; it never writes it.
  if (flags.restart || !existsSync(stateFile)) return fresh;

  const saved = readJson(stateFile);
  if (saved.exportId !== exportId) {
    fail(
      `${stateFile} records progress for a different export file (${saved.exportId}).\n` +
        'Re-run with --restart to import this file, or pass --file with the original export.',
    );
  }
  return { ...fresh, ...saved, records: { ...fresh.records, ...saved.records } };
}

function saveState() {
  if (!dryRun) writeJson(stateFile, state);
}

/** Reads the target tenant's catalog and settings. Returns problems that would make the import fail. */
async function checkTarget(catalog) {
  log.step('Checking target tenant');
  const problems = [];

  const targetCurrencies = new Set((await api.getAll('/api/currencies')).map((currency) => currency.code));
  const missingCurrencies = catalog.summary.currencies.filter((code) => !targetCurrencies.has(code));
  if (missingCurrencies.length) {
    problems.push(
      `The target tenant does not have these currencies enabled: ${missingCurrencies.join(', ')}. ` +
        'Add them in the target tenant settings, or rates in those currencies cannot be created.',
    );
  } else {
    log.ok(`currencies available: ${catalog.summary.currencies.join(', ') || 'none needed'}`);
  }

  const recordsByEntity = { PRODUCT: catalog.products, OFFERING: catalog.offerings, RATE: catalog.rates };
  for (const [entity, records] of Object.entries(recordsByEntity)) {
    const used = new Set(records.flatMap((record) => Object.keys(customFields(record.customFields) ?? {})));
    if (!used.size) continue;
    try {
      const configured = new Set(
        (await api.getAll(`/api/configurations/customFields?entity=${entity}`)).map((field) => field.key),
      );
      const missing = [...used].filter((key) => !configured.has(key));
      missing.forEach((key) => missingCustomFields[entity].add(key));
      if (missing.length) {
        warn(
          `${entity} custom fields not set up in the target tenant: ${missing.join(', ')}. ` +
            'Values for these fields will be left out of new records. Create the fields first if you need them ' +
            '(the export file lists their definitions under "customFieldDefinitions").',
        );
      } else {
        log.ok(`${entity} custom fields are set up`);
      }
    } catch (err) {
      warn(`could not check ${entity} custom fields in the target tenant: ${errorMessage(err)}`);
    }
  }

  const [usageTypes, buckets, products, offerings] = await Promise.all([
    api.getAll('/api/usageTypes'),
    api.getAll('/api/buckets'),
    api.getAll('/api/products'),
    api.getAll('/api/offerings'),
  ]);
  existing = {
    usageTypes,
    buckets,
    products,
    offerings,
    catalogRatesByOffering: new Map(
      offerings.map((offering) => [offering.id, (offering.rates ?? []).filter((rate) => rate.rateType === 'CATALOG')]),
    ),
  };
  log.ok(
    `target already has ${usageTypes.length} usage type(s), ${buckets.length} credit bucket(s), ` +
      `${products.length} product(s) and ${offerings.length} offering(s); matching records will be reused`,
  );

  return problems;
}

/**
 * Imports one record: reuses the matching target record if `find` returns one, otherwise creates it from `build`.
 * Both may throw SkipRecord (something it depends on was not imported) or Conflict.
 */
async function importRecord(kind, source, { row, find, build }) {
  const label = `${LABELS[kind].toLowerCase()} "${source.name}" (${source.id})`;
  const reportRow = { Record: LABELS[kind], Name: source.name, 'Source ID': source.id, ...row };
  rows.set(`${kind}:${source.id}`, reportRow);

  const earlier = state.records[kind][source.id];
  if (earlier) {
    Object.assign(reportRow, {
      Result: earlier.action === 'created' ? RESULT.earlierCreated : RESULT.earlierMatched,
      'Target ID': earlier.targetId,
    });
    return;
  }

  let match;
  let request;
  try {
    match = find();
    if (!match.record) request = build();
  } catch (err) {
    const reason =
      err instanceof SkipRecord || err instanceof Conflict ? err.message : `unexpected data in export file: ${errorMessage(err)}`;
    const result = err instanceof SkipRecord ? RESULT.skipped : RESULT.failed;
    Object.assign(reportRow, { Result: result, Details: reason });
    (result === RESULT.skipped ? log.skip : log.error)(`${label}: ${reason}`);
    return;
  }

  if (match.record) {
    claimed.add(match.record.id);
    remember(kind, source.id, match.record.id, 'matched');
    Object.assign(reportRow, {
      Result: dryRun ? RESULT.wouldMatch : RESULT.matched,
      'Target ID': match.record.id,
      Details: [`matched by ${match.matchedBy}`, ...match.notes].join('; '),
    });
    log.ok(`${label} ${dryRun ? 'would match' : 'matches'} existing ${match.record.id}: ${reportRow.Details}`);
    match.notes.filter((note) => note.startsWith(STATUS_DIFFERENCE)).forEach((note) => warn(`${label}: ${note}`));
    return;
  }

  const notes = [...match.notes, ...(request.notes ?? []), ...droppedCustomFieldNote(kind, source)];
  if (dryRun) {
    dryRunRequests.push({ record: LABELS[kind], name: source.name, sourceId: source.id, method: 'POST', path: request.path, body: request.body });
    remember(kind, source.id, `(new ${kind})`, 'created');
    Object.assign(reportRow, { Result: RESULT.wouldCreate, Details: notes.join('; ') });
    log.ok(`${label} would be created${notes.length ? `: ${notes.join('; ')}` : ''}`);
    return;
  }

  try {
    const created = await api.post(request.path, request.body);
    remember(kind, source.id, created.id, 'created');
    Object.assign(reportRow, { Result: RESULT.created, 'Target ID': created.id, Details: notes.join('; ') });
    log.ok(`${label} created as ${created.id}${notes.length ? `: ${notes.join('; ')}` : ''}`);
  } catch (err) {
    Object.assign(reportRow, { Result: RESULT.failed, Details: errorMessage(err) });
    log.error(`${label}: ${errorMessage(err)}`);
  }
}

/**
 * Finds the existing target record to reuse for `source`.
 *
 * A record with the same custom ID is reused if its `shape` (type, currency and so on) matches, and is a conflict if
 * not. Otherwise a record with the same name (ignoring case) and the same shape is reused; one with the same name but
 * a different shape is treated as a different record. Records already paired with another source record, or whose
 * custom ID belongs to another record in the export, are never matched by name.
 *
 * When several records share a name, on either side, only a matching description (`details`) pairs them. Otherwise
 * the record is a conflict if the target has enough candidates to be copies from an earlier import (reusing a guess
 * could pair the wrong records, and creating new ones would duplicate them), and is created new if it doesn't.
 */
function findExisting(
  kind,
  source,
  candidates,
  { shape, sourceShape = shape, describe, details, siblings = [], reservedCustomIds, nameCandidate = () => true },
) {
  const noun = LABELS[kind].toLowerCase();
  const available = candidates.filter((candidate) => !claimed.has(candidate.id));
  const customId = nonEmpty(source.customId);

  if (customId) {
    const byCustomId = available.find((candidate) => candidate.customId === customId);
    if (byCustomId) {
      if (shape(byCustomId) !== sourceShape(source)) {
        throw new Conflict(
          `existing ${noun} "${byCustomId.name}" (${byCustomId.id}) has the same custom ID but is ` +
            `${describe(byCustomId)}, not ${describe(source)}`,
        );
      }
      return { record: byCustomId, matchedBy: 'custom ID', notes: [] };
    }
  }

  const name = normalizeName(source.name);
  const sameName = available.filter((candidate) => {
    if (!nameCandidate(candidate) || normalizeName(candidate.name) !== name) return false;
    const candidateCustomId = nonEmpty(candidate.customId);
    // A different custom ID means a different record, even with the same name.
    if (!candidateCustomId || candidateCustomId === customId) return true;
    return !customId && !reservedCustomIds?.has(candidateCustomId);
  });
  const compatible = sameName.filter((candidate) => shape(candidate) === sourceShape(source));
  if (!compatible.length) {
    const notes = sameName.length
      ? [`not matched to existing ${noun} ${sameName[0].id} with the same name, which is ${describe(sameName[0])}`]
      : [];
    return { notes };
  }

  // Other exported records with the same name and shape compete for the same existing records, unless they have
  // already been paired with one.
  const twins = siblings.filter(
    (sibling) =>
      sibling !== source &&
      state.records[kind][sibling.id]?.action !== 'matched' &&
      normalizeName(sibling.name) === name &&
      sourceShape(sibling) === sourceShape(source),
  );
  if (compatible.length === 1 && !twins.length) return { record: compatible[0], matchedBy: 'name', notes: [] };

  const exact = details ? compatible.filter((candidate) => details(candidate) === details(source)) : [];
  const twinHasSameDetails = twins.some((twin) => !details || details(twin) === details(source));
  if (exact.length === 1 && !twinHasSameDetails) {
    return { record: exact[0], matchedBy: 'name and description', notes: [] };
  }

  const ids = compatible.map((candidate) => candidate.id).join(', ');
  if (compatible.length > twins.length) {
    throw new Conflict(
      twins.length
        ? `${twins.length + 1} exported and ${compatible.length} existing ${noun}s (${ids}) are named "${source.name}" ` +
            'and cannot be told apart; rename them or give them custom IDs so each one can be matched'
        : `${compatible.length} existing ${noun}s are named "${source.name}" (${ids}); ` +
            'rename them or give them custom IDs so the right one can be reused',
    );
  }
  return {
    notes: [
      `${twins.length + 1} exported ${noun}s are named "${source.name}" and this one cannot be told apart from the ` +
        `others, so existing ${noun} ${ids} was not reused`,
    ],
  };
}

/** Joins the given fields into one comparable value, treating missing and blank values alike. */
function fieldsKey(record, fields) {
  return JSON.stringify(fields.map((field) => nonEmpty(record[field])?.toString().trim() ?? null));
}

const STATUS_DIFFERENCE = 'status differs:';

// Existing records are never changed, so a status that differs from the export is left for the user to fix.
function statusDifference(noun, existingStatus, exportedStatus) {
  return (
    `${STATUS_DIFFERENCE} the existing ${noun} is ${existingStatus} but ${exportedStatus} in the export; ` +
    'it was left as it is, change it in the target tenant if needed'
  );
}

function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase();
}

function remember(kind, sourceId, targetId, action) {
  state.records[kind][sourceId] = { targetId, action };
  saveState();
}

async function deactivateProduct(product) {
  const label = `product "${product.name}" (${product.id})`;
  const id = state.records.product[product.id].targetId;
  if (state.deactivatedProducts.includes(product.id)) return;
  if (dryRun) {
    dryRunRequests.push({ record: 'Product', name: product.name, sourceId: product.id, method: 'PUT', path: `/api/products/${id}/deactivate` });
    addDetail('product', product.id, 'would be set back to inactive after its offerings');
    log.ok(`${label} would be set back to inactive`);
    return;
  }
  try {
    await api.put(`/api/products/${id}/deactivate`);
    state.deactivatedProducts.push(product.id);
    saveState();
    log.ok(`${label} set back to inactive`);
  } catch (err) {
    const row = rows.get(`product:${product.id}`);
    Object.assign(row, { Result: RESULT.failed });
    addDetail('product', product.id, `could not set back to inactive: ${errorMessage(err)}`);
    log.error(`${label}: could not set back to inactive: ${errorMessage(err)}`);
  }
}

function addDetail(kind, sourceId, detail) {
  const row = rows.get(`${kind}:${sourceId}`);
  if (row) row.Details = [row.Details, detail].filter(Boolean).join('; ');
}

/** Maps a source-tenant ID to the ID of the record created or matched for it in the target tenant. */
function targetId(kind, sourceId, name) {
  const id = state.records[kind][sourceId]?.targetId;
  if (!id) {
    throw new SkipRecord(`it depends on ${LABELS[kind].toLowerCase()} "${name ?? sourceId}" (${sourceId}), which was not imported`);
  }
  return id;
}

const TOKEN_PRODUCT_TYPES = ['RECURRING_TOKEN', 'ONETIME_TOKEN'];

function allowsRecognitionDuration(product) {
  return product.recognitionMethod && !['IMMEDIATE', 'EVENLY_MONTHLY_IN_ADVANCE'].includes(product.recognitionMethod);
}

// Older records can carry settings that the API no longer accepts for their product type. They have no effect on
// that type, so they are left out rather than failing the product.
function productSettingsLeftOut(product) {
  const notes = [];
  if (product.productType !== 'USAGE' && product.usageTypes?.length) {
    notes.push('usage types left out (only usage products can have them)');
  }
  if (product.productType !== 'ONETIME_PREPAID_CREDIT' && product.oneTimePrepaidCreditConfig) {
    notes.push('prepaid credit setting left out (only one-time prepaid credit products can have it)');
  }
  if (product.bucket && !TOKEN_PRODUCT_TYPES.includes(product.productType)) {
    notes.push('credit bucket left out (only token products can have one)');
  }
  if (product.recognitionDuration != null && !allowsRecognitionDuration(product)) {
    notes.push(`recognition duration left out (not allowed with recognition method ${product.recognitionMethod ?? 'none'})`);
  }
  return notes;
}

function orderedOfferingProducts(offering) {
  return offering.offeringProducts
    .map((op, index) => ({ op, order: op.position ?? index + 1 }))
    .sort((a, b) => a.order - b.order)
    .map(({ op }) => op);
}

function positionsRenumbered(offering) {
  return orderedOfferingProducts(offering).some((op, index) => op.position !== undefined && op.position !== index + 1);
}

function droppedCustomFieldNote(kind, source) {
  const entity = CUSTOM_FIELD_ENTITY[kind];
  if (!entity) return [];
  const dropped = Object.keys(customFields(source.customFields) ?? {}).filter((key) => missingCustomFields[entity].has(key));
  return dropped.length ? [`custom fields left out (not set up in target): ${dropped.join(', ')}`] : [];
}

function regularPrice(price) {
  return compact({
    productId: targetId('product', price.product.id, price.product.name),
    from: price.from,
    to: price.to,
    blockSize: price.blockSize,
    amount: price.amount,
    description: nonEmpty(price.description),
    priceModel: price.priceModel,
  });
}

// Overage prices draw on a credit bucket. Prices tied to a product use a cash bucket; the rest use a token bucket.
function overagePrice(price) {
  return compact({
    overageType: price.product ? 'CASH' : 'TOKEN',
    productId: price.product ? targetId('product', price.product.id, price.product.name) : undefined,
    bucketId: targetId('bucket', price.bucketId),
    from: price.from,
    to: price.to,
    blockSize: price.blockSize,
    amount: price.amount,
    description: nonEmpty(price.description),
    priceModel: price.priceModel,
  });
}

function rateOptions(options, offeringProductIds) {
  return compact({
    // Options for products no longer on the offering would be rejected, so they are left out.
    productOptions: (options.productOptions ?? [])
      .filter((option) => offeringProductIds.has(option.productId))
      .map((option) =>
        compact({
          productId: targetId('product', option.productId),
          aggregationModel: option.aggregationModel,
          usageBucketConsumptionMapping: option.usageBucketConsumptionMapping
            ? compact({
                bucketId: targetId('bucket', option.usageBucketConsumptionMapping.bucketId),
                conversionFactor: option.usageBucketConsumptionMapping.conversionFactor,
              })
            : undefined,
        }),
      ),
    priceDisplay: options.priceDisplay,
    tokenAllocationFrequencyInMonth: options.tokenAllocationFrequencyInMonth,
  });
}

/** Minimum commit and percent-of-total configs may list products; those IDs are remapped to the target tenant. */
function withMappedProducts(config) {
  return compact({
    ...config,
    productIds: Array.isArray(config.productIds)
      ? config.productIds.map((productId) => targetId('product', productId))
      : undefined,
  });
}

// List responses include every configured custom field, with null for fields that have no value.
function customFields(fields) {
  if (!fields) return undefined;
  const withValues = compact(fields);
  return Object.keys(withValues).length ? withValues : undefined;
}

function warn(message) {
  warnings.push(message);
  log.warn(message);
}

function finish(logFile) {
  const reportRows = [...rows.values()];
  writeCsv(reportFile, reportRows, REPORT_COLUMNS);
  if (dryRun) writeJson(requestsFile, dryRunRequests);

  log.step(dryRun ? 'Dry run finished' : 'Import finished');
  const counts = Object.values(RESULT)
    .map((result) => [result, reportRows.filter((row) => row.Result === result).length])
    .filter(([, count]) => count > 0)
    .map(([result, count]) => `${result.toLowerCase()}: ${count}`);
  log.info(`Records ${counts.join(', ') || 'none'}.`);
  if (warnings.length) log.info(`${warnings.length} warning(s), listed above.`);
  log.info(`Report:   ${reportFile}`);
  if (dryRun) log.info(`Requests: ${requestsFile}`);
  log.info(`Log:      ${logFile}`);

  if (reportRows.some((row) => row.Result === RESULT.failed)) {
    log.info('Fix the failures listed in the report and run the same command again; imported records are not repeated.');
    process.exitCode = 1;
  }
}

main().catch((err) => fail(errorMessage(err)));
