# Product catalog migration

Two scripts that copy a MonetizeNow product catalog from one tenant to another, for example from a sandbox to
production:

- `export-catalog.mjs` reads the catalog from the source tenant and saves it to a JSON file.
- `import-catalog.mjs` adds the records from that file to the target tenant, reusing any that already exist there.

Both scripts use the [MonetizeNow API](https://docs.monetizenow.io/reference/getting-started-with-your-api) with an
API key. They need Node.js 18 or newer and nothing else: there are no packages to install.

## What is copied

| Record | Notes |
| --- | --- |
| Usage types | All, with their status. |
| Credit buckets | All. |
| Products | All, active and inactive, including usage types, credit bucket, revenue recognition, tax, proration and display settings, and custom field values. |
| Offerings | Active offerings that have at least one product, including product order, mandatory/optional products, quantity display, custom ID, finance ID and custom field values. |
| Rates | Active catalog rates on those offerings, including all prices and tiers, block sizes, overage prices, rate options, minimum commit and percent-of-total settings, revenue channels and custom field values. |

## What is not copied

- Discounts. Re-create them in the target tenant and attach them to offerings after importing. The export report
  lists which offerings have discounts.
- Account-specific rates, and inactive or canceled rates.
- Inactive, expired, canceled and archived offerings.
- Custom field definitions. The export file lists the source tenant's product, offering and rate custom fields under
  `customFieldDefinitions`, so you can create the same fields in the target tenant first.
- Currencies and other tenant settings.
- Customer and transaction data (accounts, quotes, contracts, subscriptions, invoices).

## Records that already exist in the target tenant

The import never changes or deletes anything in the target tenant. Before creating a record, it looks for an existing
one it can reuse instead:

1. **Same custom ID.** Reused if it is the same kind of record (for example the same product type). If the type is
   different, the record is reported as a conflict and not imported.
2. **Same name** (ignoring upper/lower case) **and the same kind:** the same product type, bucket type or usage unit.
   An offering must have the same type and the same products. A rate must be on the same offering and have the same
   currency and billing frequency, and only active rates are reused this way. A record with the same name that differs
   in any of these ways is treated as a different record, and a new one is created.
3. **Several records with the same name**, in the target tenant or in the export itself. A record is only reused if
   its description (and SKU or finance ID, where relevant) also singles it out. If it doesn't:
   - when the target tenant has enough same-named records to be copies from an earlier import, the record is
     reported as a conflict, so that nothing is paired wrongly or duplicated. Rename the duplicates or give them custom
     IDs, then run the import again.
   - otherwise a new record is created, and the report says which existing record was not reused.

A reused record is used as it is: its prices, settings and status are not updated to match the export. The import
warns, and the report notes, when a reused record's status differs from the export.

Because of this matching, running the import again, or importing into a tenant that already has part of the catalog,
does not create duplicates.

## Before you start

1. Install Node.js 18 or newer (`node --version` to check).
2. In each tenant, create an API key under **Settings > API Keys** while signed in as an admin (see
   [Getting started with the API](https://docs.monetizenow.io/reference/getting-started-with-your-api)).
3. In the target tenant:
   - Enable every currency your rates use. The import checks this and stops if one is missing.
   - Create the product, offering and rate custom fields you want to keep, with the same keys as the source tenant.
     Values for fields that don't exist in the target tenant are left out, and the report says which.
     Dropdown and multi-select fields need the same option values.
4. Copy `.env.example` to `.env` and fill in both API keys. Use `https://api-eu.monetizeplatform.com` as the API URL
   for tenants hosted in the EU.

## Running the migration

```sh
# 1. Export from the source tenant. Writes output/catalog-export.json and an export report.
node export-catalog.mjs

# 2. See what the import would do, without changing anything.
node import-catalog.mjs --dry-run

# 3. Import into the target tenant. You'll be asked to confirm first.
node import-catalog.mjs
```

Review the dry run's report before importing: it lists every record with "Would create" or "Would match existing",
and anything that would be skipped or fail. The dry run also checks the target tenant's currencies and custom fields.

### Options

| Script | Option | Effect |
| --- | --- | --- |
| export | `--out <file>` | Write the export somewhere other than `output/catalog-export.json`. |
| import | `--file <file>` | Import a different export file. |
| import | `--dry-run` | Report what would be created or reused, without changing anything. |
| import | `--yes` | Skip the confirmation prompt, for example when running unattended. |
| import | `--restart` | Ignore progress saved by an earlier run and match every record again. Records the earlier run created are then treated like any other existing record and left as they are (see the note on inactive products below). |

Instead of a `.env` file you can set `SOURCE_API_KEY`, `SOURCE_API_URL`, `TARGET_API_KEY` and `TARGET_API_URL` as
environment variables.

## Reports and logs

Every run writes a report you can open in Excel or Google Sheets, and a log. All files go in the `output` folder, and
their names include the time of the run.

The **import report** (`import-report-<time>.csv`, or `import-dry-run-report-<time>.csv` for a dry run) has one row
for every record in the export file:

| Column | Contents |
| --- | --- |
| Record | Usage type, Credit bucket, Product, Offering or Rate. |
| Name | The record's name. |
| Offering | For rates, the offering the rate belongs to. |
| Type | Product type, offering type, bucket type, usage unit, or a rate's currency and billing frequency. |
| Status | The record's status in the source tenant. |
| Result | What happened: Created, Matched existing, Created in an earlier run, Matched in an earlier run, Skipped, or Failed (Would create / Would match existing in a dry run). |
| Details | Why it was skipped or failed (including the API's error message), how it was matched, and anything to be aware of. |
| Source ID / Target ID | The record's ID in the source tenant and in the target tenant. |

The **export report** (`export-report-<time>.csv`) lists every exported record, and any active offerings that were
skipped.

The **log** (`logs/export-<time>.log`, `logs/import-<time>.log`) has everything the script printed, with a
timestamp on each line.

Other files:

| File | Contents |
| --- | --- |
| `catalog-export.json` | The exported catalog. |
| `import-dry-run-requests-<time>.json` | The exact requests a dry run would have sent. |
| `import-state-<id>.json` | Import progress for one target tenant, used to resume. |

The scripts never write API keys to any file. The export file and reports contain your catalog data, so keep the
`output` folder and `.env` somewhere private.

## If something fails

The import carries on past a record that fails, and the report lists every failure with the reason. Records that
depend on a failed record, such as the rates of an offering that failed, are skipped and listed with the reason.

Fix the cause and run the same import command again. Progress is saved after each record in
`output/import-state-<id>.json` (`<id>` identifies the target tenant's API key), so records imported by the earlier
run are not repeated. It is also safe to stop a run with Ctrl+C and start it again.

Common causes of failures:

- **401 or 403**: the API key is wrong, belongs to a different environment (US or EU), or its user is not an admin.
- **Conflict with an existing record**: see [Records that already exist in the target tenant](#records-that-already-exist-in-the-target-tenant).
- **Invalid dropdown value**: a dropdown or multi-select custom field in the target tenant is missing an option that
  the source tenant uses.
- **Currency not supported**: enable the currency in the target tenant.
- **A record the API no longer accepts**: catalog records created before a newer validation rule existed can be
  rejected when they are created again, for example a percent-of-total offering with more than one product, or an
  offering with two usage products on the same usage type. The report shows the API's reason. Correct the record in
  the source tenant and export again, or create it by hand in the target tenant.

## Notes

- Inactive products that belong to an exported offering are created active, because an offering can't be created
  with an inactive product, and are set back to inactive once the offerings exist. If a run stops before that and
  the next run uses `--restart`, those products are reused as existing records and stay active; the import warns
  about each one so you can deactivate it in the target tenant.
- Offerings keep their start and end dates, and rates keep theirs.
- Settings that don't apply to a record's type, which older records sometimes carry, are left out rather than failing
  the record, and the report notes each one. For example, usage types on a product that isn't a usage product.
- If an offering's product positions have gaps, they are renumbered in the same order.
- A percent-of-total rate with no minimum total gets a minimum total of 0, which the API uses by default. It means the
  same thing.
