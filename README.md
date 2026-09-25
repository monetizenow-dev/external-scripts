# MonetizeNow external scripts

Ready-to-run scripts for common tasks with the [MonetizeNow API](https://docs.monetizenow.io/reference/getting-started-with-your-api),
such as copying data between tenants. Each script lives in its own folder with its own README and runs on its own.

## Scripts

| Folder | What it does |
| --- | --- |
| [`catalog-migration`](catalog-migration/) | Copies a product catalog (usage types, credit buckets, products, offerings and rates) from one tenant to another, for example from a sandbox to production. Reuses records that already exist instead of duplicating them, and writes a CSV report of every record. |

## Getting started

1. Get the scripts: clone this repository, or download it from GitHub with **Code > Download ZIP**.
2. Create an API key in your tenant under **Settings > API Keys**. The
   [API getting started guide](https://docs.monetizenow.io/reference/getting-started-with-your-api) covers API keys,
   authentication and pagination.
3. Follow the README in the script's folder.

Scripts connect to the US API, `https://api.monetizeplatform.com`, unless you give them another URL. Tenants hosted in
the EU use `https://api-eu.monetizeplatform.com`. Each script's README explains how to set this.

## Before you run a script

- Scripts that change data say so in their README, and offer a dry run where they can. Try a script against a
  sandbox tenant first.
- Scripts read API keys from a `.env` file or from environment variables. This repository's `.gitignore` excludes
  `.env` files, so keys are not committed by accident.
- Scripts write their output, such as exports, reports and logs, to an `output` folder. These files can contain your
  tenant's data, and the `.gitignore` excludes them too.

## License

[MIT](LICENSE)
