# Installation Checklist — SEO Audit Runner

Print this and tick every box in order. Details for every step:
`deploy/SERVER-HANDOVER.md`.

## Before you start
- [ ] Linux host with systemd ≥ 235, 2 GB free RAM, 5 GB free disk
- [ ] Outbound access to the SEO application API and Slack verified
- [ ] Node.js ≥ 22.5 installed (24 LTS preferred): `node --version`
- [ ] Package on the server (repository checkout or extracted archive)
- [ ] You have root (sudo) access

## Install
- [ ] `cd <checkout>/ops/seo-audit-runner`
- [ ] `sudo bash deploy/install.sh --node "$(command -v node)"`
- [ ] Installer ended with `installation complete` and validation OK
- [ ] `sudo systemctl daemon-reload`

## Configure
- [ ] `sudo nano /etc/seo-audit-runner/runner.env` — set `SEO_API_BASE_URL`
- [ ] Slack: set `SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID`, then `NOTIFICATIONS_ENABLED=true`
- [ ] `sudo chmod 0640 /etc/seo-audit-runner/runner.env && sudo chown root:seo-runner /etc/seo-audit-runner/runner.env`
- [ ] `sudo -u seo-runner seo-audit-runner validate-config` → `Configuration OK`

## Verify
- [ ] `sudo bash deploy/smoke-test.sh --with-dry-run` → `RESULT: PASS`
- [ ] `sudo -u seo-runner seo-audit-runner doctor` → exit 0 or 2
- [ ] `sudo -u seo-runner seo-audit-runner list-projects` shows expected projects
- [ ] `sudo -u seo-runner seo-audit-runner run --all --dry-run` (read-only)

## First real audit (controlled)
- [ ] `sudo -u seo-runner seo-audit-runner run --project <approved-id>` watched live
- [ ] Results, Slack message, and application health reviewed

## Automation (only after the above)
- [ ] Scheduling model chosen: ☐ A (daily timer) ☐ B (tick + schedules) ☐ none yet
- [ ] Model A: `sudo systemctl enable --now seo-audit-runner.timer seo-runner-retry.timer`
- [ ] Model B: schedule created + enabled, then `sudo systemctl enable --now seo-runner-tick.timer seo-runner-retry.timer`
- [ ] `systemctl list-timers 'seo-*'` shows the expected next run
- [ ] NOT both models; NOT cron and systemd together

## Safety net
- [ ] `sudo -u seo-runner bash deploy/backup.sh` produced `state-<stamp>.tar.gz`
- [ ] Restore procedure read (`deploy/restore.sh --help`)
- [ ] Rollback procedure read (`deploy/rollback.sh --help`)
- [ ] Handover guide delivered to the operating team
