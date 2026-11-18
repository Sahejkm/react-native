/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @noflow
 * @format
 */

/**
 * Records a maintainer's approval of a PR's visual differences and updates
 * the approval gate and the platform checks, which pass once differences are
 * approved. Runs from the default branch on `pull_request_target`
 * when the approval label is added or removed. It never checks out or runs
 * pull request code.
 *
 *   node approve-run.js prepare  Decide, and stage an approval record to
 *                                upload under OUT_DIR.
 *   node approve-run.js report   After the upload, update the gate and
 *                                platform checks.
 */

const {
  APPROVAL_LABEL,
  APPROVER_PERMISSIONS,
  GATE_CHECK_NAME,
  gateDecision,
} = require('./approval');
const {createGitHubClient} = require('./github');
const {platformCheckRun} = require('./report');
const {
  approvalKey,
  fetchJsonOrNull,
  listPrefixes,
  publicUrl,
} = require('./storage');
const fs = require('node:fs');
const path = require('node:path');

function requireEnv(name) {
  const value = process.env[name];
  if (value == null || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * The most recent comparison for a PR head, as its storage prefix and
 * results, or null.
 */
async function latestResults({bucket, publicBaseUrl, prNumber, headSha}) {
  const runs = await listPrefixes(
    bucket,
    `reports/pull/${prNumber}/${headSha}/`,
  );
  const latest = runs
    .map(prefix => {
      const match = /\/(\d+)-(\d+)\/$/.exec(prefix);
      return match == null
        ? null
        : {prefix, runId: Number(match[1]), attempt: Number(match[2])};
    })
    .filter(Boolean)
    .sort((a, b) => b.runId - a.runId || b.attempt - a.attempt)[0];
  if (latest == null) {
    return null;
  }
  const results = await fetchJsonOrNull(
    publicUrl(publicBaseUrl, `${latest.prefix}results.json`),
  );
  return results == null
    ? null
    : {prefix: latest.prefix.replace(/\/$/, ''), results};
}

async function prepare() {
  const github = createGitHubClient();
  const outDir = requireEnv('OUT_DIR');
  const event = JSON.parse(
    fs.readFileSync(requireEnv('GITHUB_EVENT_PATH'), 'utf8'),
  );
  const writeState = state =>
    fs.writeFileSync(
      path.join(outDir, 'state.json'),
      `${JSON.stringify(state)}\n`,
    );
  fs.mkdirSync(outDir, {recursive: true});

  if (event.label?.name !== APPROVAL_LABEL) {
    writeState(null);
    return;
  }

  const prNumber = event.pull_request.number;
  const headSha = event.pull_request.head.sha;
  const latest = await latestResults({
    bucket: requireEnv('VISUAL_BUCKET'),
    publicBaseUrl: requireEnv('VISUAL_PUBLIC_BASE_URL'),
    prNumber,
    headSha,
  });
  const results = latest?.results ?? null;
  const fingerprint = results?.fingerprint ?? null;

  if (event.action === 'labeled') {
    const approver = event.sender.login;
    const permission = await github.permission(approver);
    if (!APPROVER_PERMISSIONS.includes(permission)) {
      await github.removeLabel(prNumber, APPROVAL_LABEL);
      await github.comment(
        prNumber,
        `@${approver} \`${APPROVAL_LABEL}\` needs write access to this repository, so it was removed.`,
      );
      writeState(null);
      return;
    }
    if (results == null) {
      await github.removeLabel(prNumber, APPROVAL_LABEL);
      await github.comment(
        prNumber,
        `There is no visual report for \`${headSha.slice(0, 12)}\` yet, so \`${APPROVAL_LABEL}\` was removed. Apply it again once the report is posted.`,
      );
      writeState(null);
      return;
    }
    if (fingerprint != null) {
      const key = approvalKey(prNumber, fingerprint);
      const record = {
        fingerprint,
        approver,
        approvedAt: new Date().toISOString(),
        headSha,
      };
      const recordPath = path.join(outDir, 'upload', key);
      fs.mkdirSync(path.dirname(recordPath), {recursive: true});
      fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    }
  }

  writeState({
    prNumber,
    headSha,
    fingerprint,
    labelPresent: event.action === 'labeled',
    reportPrefix: latest?.prefix ?? null,
  });
}

async function report() {
  const github = createGitHubClient();
  const outDir = requireEnv('OUT_DIR');
  const state = JSON.parse(
    fs.readFileSync(path.join(outDir, 'state.json'), 'utf8'),
  );
  if (state == null) {
    return;
  }
  const {prNumber, headSha, fingerprint, labelPresent, reportPrefix} = state;
  const publicBaseUrl = requireEnv('VISUAL_PUBLIC_BASE_URL');
  const approval =
    fingerprint == null
      ? null
      : await fetchJsonOrNull(
          publicUrl(publicBaseUrl, approvalKey(prNumber, fingerprint)),
        );
  const decision = gateDecision({fingerprint, labelPresent, approval});
  if (reportPrefix != null) {
    const detailsUrl = publicUrl(publicBaseUrl, `${reportPrefix}/results.json`);
    const results = await fetchJsonOrNull(detailsUrl);
    for (const platform of results?.platforms ?? []) {
      const {name, conclusion, output} = platformCheckRun({
        platform,
        prefix: reportPrefix,
        publicBaseUrl,
        approver: decision.approver,
      });
      await github.createCheckRun({
        name,
        headSha,
        conclusion,
        output,
        detailsUrl,
      });
    }
  }
  await github.createCheckRun({
    name: GATE_CHECK_NAME,
    headSha,
    conclusion: decision.conclusion,
    output: {title: decision.summary, summary: decision.summary},
  });
  console.info(decision.summary);
}

async function main(command = process.argv[2]) {
  if (command === 'prepare') {
    await prepare();
  } else if (command === 'report') {
    await report();
  } else {
    throw new Error('Usage: node approve-run.js prepare|report');
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {latestResults, report};
