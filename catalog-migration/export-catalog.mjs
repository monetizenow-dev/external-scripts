#!/usr/bin/env node
// Exports a MonetizeNow product catalog to a JSON file that import-catalog.mjs can load into another tenant.
//
// Exported: usage types, credit buckets, all products, active offerings, and the active catalog rates on those
// offerings (with their prices). Custom field definitions for products, offerings and rates are included for
// reference so you can check the target tenant has the same fields. See README.md for what is not exported.

import { join, resolve } from 'node:path';
import {
  DEFAULT_API_URL,
  EXPORT_FORMAT_VERSION,
  OUTPUT_DIR,
  RUN_STAMP,
  assertNodeVersion,
  createApiClient,
  errorMessage,
  fail,
  loadEnvFile,
  log,
  mapWithConcurrency,
  openLogFile,
  parseFlags,
  requireEnv,
  writeCsv,
  writeJson,
} from './lib.mjs';

const HELP = `
Usage: node export-catalog.mjs [--out <file>]

Exports the product catalog from the tenant that SOURCE_API_KEY belongs to.

  --out <file>   Where to write the export (default: output/catalog-export.json)
  --help         Show this message

Environment (or .env):
  SOURCE_API_KEY   API key for the tenant to export from (required)
  SOURCE_API_URL   API base URL (default: ${DEFAULT_API_URL})
`;

const CUSTOM_FIELD_ENTITIES = ['PRODUCT', 'OFFERING', 'RATE'];
const RATE_FETCH_CONCURRENCY = 5;
const REPORT_COLUMNS = ['Record', 'Name', 'Offering', 'Type', 'Status', 'Result', 'Details', 'ID'];

assertNodeVersion();
loadEnvFile();
const flags = parseFlags(process.argv.slice(2), { out: 'string', help: 'boolean' });
if (flags.help) {
  console.log(HELP);
  process.exit(0);
}

const api = createApiClient({
  apiUrl: process.env.SOURCE_API_URL?.trim() || DEFAULT_API_URL,
  apiKey: requireEnv('SOURCE_API_KEY'),
});
const outFile = resolve(flags.out ?? join(OUTPUT_DIR, 'catalog-export.json'));
const reportFile = join(OUTPUT_DIR, `export-report-${RUN_STAMP}.csv`);
const report = [];

async function main() {
  const logFile = openLogFile('export');
  log.info(`Exporting product catalog from ${api.apiUrl}`);

  log.step('Offerings (active only)');
  const offerings = [];
  for (const offering of await api.getAll('/api/offerings?status=ACTIVE&sort=name:asc')) {
    if (!offering.offeringProducts?.length) {
      log.skip(`offering "${offering.name}" (${offering.id}) has no products`);
      report.push(offeringRow(offering, 'Skipped', 'has no products'));
      continue;
    }
    // The offering list includes account-specific rates; only catalog rates are migrated.
    const catalogRateIds = (offering.rates ?? [])
      .filter((rate) => rate.rateType === 'CATALOG' && rate.status === 'ACTIVE')
      .map((rate) => rate.id);
    const { rates, ...rest } = offering;
    offerings.push({ ...rest, catalogRateIds });
    log.ok(`offering "${offering.name}" (${offering.id}) with ${catalogRateIds.length} active catalog rate(s)`);
  }

  log.step('Rates');
  const rateIds = offerings.flatMap((offering) => offering.catalogRateIds);
  const rates = await mapWithConcurrency(rateIds, RATE_FETCH_CONCURRENCY, async (id) => {
    const rate = await api.get(`/api/rates/${id}`);
    log.ok(`rate "${rate.name}" (${rate.id})`);
    return rate;
  });

  log.step('Products');
  // All products, not just those on exported offerings, so standalone products come across too.
  const products = await api.getAll('/api/products?sort=name:asc');
  log.ok(`${products.length} product(s)`);

  log.step('Usage types');
  const usageTypes = await api.getAll('/api/usageTypes?sort=name:asc');
  log.ok(`${usageTypes.length} usage type(s)`);

  log.step('Credit buckets');
  const buckets = await api.getAll('/api/buckets');
  log.ok(`${buckets.length} credit bucket(s)`);

  log.step('Custom field definitions (for reference)');
  const customFieldDefinitions = {};
  for (const entity of CUSTOM_FIELD_ENTITIES) {
    try {
      const definitions = await api.getAll(`/api/configurations/customFields?entity=${entity}`);
      customFieldDefinitions[entity] = definitions.map(({ key, displayLabel, type, status, description, values }) => ({
        key,
        displayLabel,
        type,
        status,
        description,
        values,
      }));
      log.ok(`${entity}: ${definitions.length} field(s)`);
    } catch (err) {
      log.warn(`could not read ${entity} custom field definitions: ${errorMessage(err)}`);
    }
  }

  const offeringsWithDiscounts = offerings.filter((offering) => offering.discounts?.length);
  if (offeringsWithDiscounts.length) {
    log.warn(
      `${offeringsWithDiscounts.length} offering(s) have discounts attached. Discounts are not exported; ` +
        're-create and attach them in the target tenant after importing.',
    );
  }

  const currencies = [...new Set(rates.map((rate) => rate.currency))].sort();
  const summary = {
    usageTypes: usageTypes.length,
    buckets: buckets.length,
    products: products.length,
    offerings: offerings.length,
    rates: rates.length,
    currencies,
  };

  writeJson(outFile, {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { apiUrl: api.apiUrl },
    summary,
    customFieldDefinitions,
    usageTypes,
    buckets,
    products,
    offerings,
    rates,
  });

  const offeringNames = new Map(offerings.map((offering) => [offering.id, offering.name]));
  report.push(
    ...usageTypes.map((u) => row('Usage type', u, { Type: `unit: ${u.unitName}`, Status: u.status })),
    ...buckets.map((b) => row('Credit bucket', b, { Type: b.type })),
    ...products.map((p) => row('Product', p, { Type: p.productType, Status: p.status })),
    ...offerings.map((o) =>
      offeringRow(o, 'Exported', o.discounts?.length ? `${o.discounts.length} discount(s) attached, not exported` : ''),
    ),
    ...rates.map((r) =>
      row('Rate', r, {
        Offering: offeringNames.get(r.offering?.id) ?? r.offering?.name,
        Type: `${r.currency} ${r.billingFrequency}`,
        Status: r.status,
      }),
    ),
  );
  writeCsv(reportFile, report, REPORT_COLUMNS);

  log.step('Done');
  log.info(
    `Exported ${summary.usageTypes} usage types, ${summary.buckets} credit buckets, ${summary.products} products, ` +
      `${summary.offerings} offerings and ${summary.rates} rates (currencies: ${currencies.join(', ') || 'none'}).`,
  );
  log.info(`Export file: ${outFile}`);
  log.info(`Report:      ${reportFile}`);
  log.info(`Log:         ${logFile}`);
}

function row(record, source, fields) {
  return { Record: record, Name: source.name, Result: 'Exported', ID: source.id, ...fields };
}

function offeringRow(offering, result, details) {
  return { ...row('Offering', offering, { Type: offering.type, Status: offering.status }), Result: result, Details: details };
}

main().catch((err) => fail(errorMessage(err)));
