# Maintained PageMon base

This branch tracks the upstream PageMon application with runtime maintenance and security fixes only. It intentionally excludes the Central West Alerts branding, maps, feeds, dashboards, receiver status features, and deployment-specific configuration.

## Requirements

- Node.js 18 or newer
- A backup of the PageMon database and both `server/config` and `client/config`

## Updating an existing installation

```bash
cd /path/to/pagermon
git remote add rodgrech https://github.com/rodgrech/pagermon.git
git fetch rodgrech
git checkout master
git merge --ff-only rodgrech/maintained-base

cd server
npm ci --omit=dev
cd ../client
npm ci --omit=dev
```

Restart the PageMon server and decoder services after installation. If the fast-forward merge refuses, preserve and commit any local customisations before performing a normal merge.

## Maintenance included

- Locked server and decoder dependencies
- Current Express, Passport, Knex, Socket.IO and EJS compatibility
- Login rate limiting
- SQLite migration compatibility with current Knex
- Native HTTPS implementations for Telegram and Prowl notifications
- Maintained Twitter API client
- Modern decoder HTTP delivery without the deprecated `request` package

Production dependency audits for both the server and client report zero known vulnerabilities at publication time.
