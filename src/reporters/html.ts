import { join } from 'node:path';
import type {
  AndroidAnalysis,
  AndroidArtifactAnalysis,
  ChecklistItem,
  IosAnalysis,
  Issue,
  JsUnusedAnalysis,
  PodSummary,
  ProjectAnalysis,
} from '../types';
import { writeText } from '../utils/fs';
import { formatBytes, formatBytesExact, formatPercent } from '../utils/size';

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function display(value: unknown, fallback = 'Not specified'): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  return String(value);
}

function scoreTone(score: number): 'ok' | 'warn' | 'crit' {
  if (score >= 80) return 'ok';
  if (score >= 60) return 'warn';
  return 'crit';
}

function scoreLabel(score: number): string {
  if (score >= 80) return 'Healthy';
  if (score >= 60) return 'Needs review';
  return 'Action needed';
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

function sev(severity: string): string {
  return `<span class="sev ${esc(severity)}">${esc(severity)}</span>`;
}

function pill(text: string, kind = 'neutral'): string {
  return `<span class="pill ${kind}">${esc(text)}</span>`;
}

function callout(title: string, body: string, kind: 'info' | 'warn' = 'info'): string {
  return `<div class="callout ${kind}"><strong>${esc(title)}</strong><p>${body}</p></div>`;
}

function breakable(text: string): string {
  return esc(text).replace(/([./_-])/g, '$1<wbr>');
}

function stat(label: string, value: unknown, hint?: string): string {
  const text = display(value);
  return `<div class="stat">
    <span class="stat-label">${esc(label)}</span>
    <strong class="stat-value" title="${esc(text)}">${breakable(text)}</strong>
    ${hint ? `<span class="stat-hint">${breakable(hint)}</span>` : ''}
  </div>`;
}

function issueCard(item: Issue): string {
  const impact =
    item.estimatedImpactBytes !== undefined
      ? `${formatBytes(item.estimatedImpactBytes)}${item.estimatedImpactLabel ? ` · ${item.estimatedImpactLabel}` : ''}`
      : item.estimatedImpactLabel ?? 'Not measured';
  const evidence = item.evidence.length
    ? item.evidence.map((line) => `<code>${esc(line)}</code>`).join('')
    : '—';
  return `<article class="issue sev-border-${esc(item.severity)}">
    <div class="issue-top">
      ${sev(item.severity)}
      ${pill(item.platform, 'neutral')}
      ${pill(item.category, 'muted')}
      ${pill(item.confidence, 'muted')}
    </div>
    <h3>${esc(item.title)}</h3>
    <p class="issue-desc">${esc(item.description)}</p>
    <div class="issue-grid">
      <div><span>Affected</span><div>${esc(item.affected ?? item.platform)}</div></div>
      <div><span>Impact</span><div>${esc(impact)}</div></div>
      <div class="span-2"><span>Evidence</span><div class="evidence">${evidence}</div></div>
      <div class="span-2 reco"><span>What to do</span><div>${esc(item.recommendation)}</div></div>
    </div>
  </article>`;
}

function scoreCard(label: string, score: number, tab: string, findings: number): string {
  const tone = scoreTone(score);
  const findingLabel = findings === 1 ? '1 finding' : `${findings} findings`;
  return `<button type="button" class="score-card tone-${tone}" data-goto-tab="${esc(tab)}" aria-label="Open ${esc(label)} details, score ${score} of 100, ${findingLabel}">
    <div class="score-card-top">
      <h3>${esc(label)}</h3>
      <span class="score-status">${esc(scoreLabel(score))}</span>
    </div>
    <div class="score-num">${score}<span class="score-denom"> / 100</span></div>
    <p class="score-hint">${esc(findingLabel)} · click for details</p>
    <div class="bar"><span style="width:${score}%"></span></div>
  </button>`;
}

function scoreFindingsBlock(title: string, items: Issue[]): string {
  if (!items.length) {
    return callout(title, 'No findings were counted for this score in this run.', 'info');
  }
  const unique = (() => {
    const seen = new Set<string>();
    const out: Issue[] = [];
    for (const item of items) {
      const evidenceLoc = item.evidence?.[0] ? String(item.evidence[0]) : '';
      const key = item.id ?? `${item.title}|${item.affected ?? ''}|${evidenceLoc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  })();

  const rows = unique
    .slice(0, 12)
    .map((item) => {
      const severityKind =
        item.severity === 'critical' ? 'crit' : item.severity === 'warning' ? 'warn' : 'muted';
      const location = item.evidence?.[0] ? String(item.evidence[0]) : item.affected ?? item.platform ?? '—';
      return `<li class="finding-row">
        <div>
          <strong>${esc(item.title)}</strong>
          ${pill(item.severity, severityKind)}
          <span class="muted"> · ${esc(item.category)} · ${esc(location)}</span>
        </div>
        <div class="finding-copy" data-findings-copy="summary">${esc(item.title)}</div>
        <div class="finding-copy" data-findings-copy="detail" hidden>${esc(item.description)}</div>
        <div class="finding-copy" data-findings-copy="action" hidden>${esc(item.recommendation)}</div>
      </li>`;
    })
    .join('');
  const extra = unique.length > 12 ? `<p class="muted">Showing first 12 of ${unique.length} findings.</p>` : '';
  return `<div class="card score-findings">
    <h3>${esc(title)} (${items.length})</h3>
    <div class="seg findings-view" role="tablist" aria-label="Findings display type">
      <button type="button" class="active" data-findings-view="summary">Summary</button>
      <button type="button" data-findings-view="detail">Detail</button>
      <button type="button" data-findings-view="action">What to do</button>
    </div>
    <ul>${rows}</ul>
    ${extra}
  </div>`;
}

function checklist(items: ChecklistItem[]): string {
  if (!items.length) return '<p class="muted">No checklist items.</p>';
  return `<ul class="checks">${items
    .map((item) => {
      const mark =
        item.status === 'ready' ? '✓' : item.status === 'warning' ? '!' : item.status === 'not-ready' ? '✕' : '–';
      return `<li class="${esc(item.status)}">
        <span class="check-mark">${mark}</span>
        <div><strong>${esc(item.label)}</strong><p>${esc(item.detail)}</p></div>
      </li>`;
    })
    .join('')}</ul>`;
}

function tableWrap(html: string, extraClass = ''): string {
  return `<div class="table-wrap ${extraClass}">${html}</div>`;
}

interface GroupedPod {
  name: string;
  version?: string;
  specs: string[];
}

function groupPods(pods: PodSummary[]): GroupedPod[] {
  const groups = new Map<string, GroupedPod>();
  for (const pod of pods) {
    const slash = pod.name.indexOf('/');
    const root = slash === -1 ? pod.name : pod.name.slice(0, slash);
    const spec = slash === -1 ? '' : pod.name.slice(slash + 1);
    const existing = groups.get(root);
    if (!existing) {
      groups.set(root, { name: root, version: pod.version, specs: spec ? [spec] : [] });
      continue;
    }
    if (spec && !existing.specs.includes(spec)) existing.specs.push(spec);
    existing.version = existing.version ?? pod.version;
  }
  return [...groups.values()];
}

function podsCard(pods: PodSummary[]): string {
  if (!pods.length) return '';
  const grouped = groupPods(pods);
  const rows = grouped
    .map((pod) => {
      const specs = pod.specs.length
        ? `<div class="pod-specs">${pod.specs.map((spec) => esc(spec)).join(' · ')}</div>`
        : '';
      return `<tr data-filter-text="${esc(`${pod.name} ${pod.specs.join(' ')} ${pod.version ?? ''}`.toLowerCase())}">
        <td>
          <div class="pod-name" title="${esc(pod.name)}">${breakable(pod.name)}</div>
          ${specs}
        </td>
        <td><span class="ver">${esc(pod.version ?? '—')}</span></td>
      </tr>`;
    })
    .join('');
  return `<div class="list-card">
    <div class="list-card-head">
      <div class="list-card-title">
        <h3>CocoaPods</h3>
        <p class="muted">${grouped.length} unique pods · ${pods.length} lockfile entries</p>
      </div>
      <div class="list-tools">
        <input class="list-search" data-filter="pods-list" type="search" placeholder="Filter pods" aria-label="Filter pods"/>
      </div>
    </div>
    <div class="list-scroll">
      <table class="compact" id="pods-list">
        <thead><tr><th>Pod</th><th>Version</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>`;
}

function androidPanel(android: AndroidAnalysis): string {
  if (!android.detected) {
    return callout('Android not detected', esc(android.missingReason ?? 'No Android project found.'), 'warn');
  }

  const config = `<div class="stat-grid">
    ${stat('Compile SDK', android.sdk?.compileSdk)}
    ${stat('Target SDK', android.sdk?.targetSdk)}
    ${stat('Min SDK', android.sdk?.minSdk)}
    ${stat('Hermes', android.build?.hermesEnabled)}
    ${stat('New Architecture', android.build?.newArchEnabled)}
    ${stat('R8 / minify (release)', android.build?.minifyEnabled)}
    ${stat('Shrink resources', android.build?.shrinkResources)}
    ${stat('Signing config', android.build?.signingConfigPresent ? 'Present' : 'Not found')}
    ${stat('Application ID', android.applicationId ?? android.manifestPackage)}
    ${stat('ABIs', android.build?.abiFilters.length ? android.build.abiFilters.join(', ') : 'Not filtered')}
  </div>`;

  const artifact = android.artifact
    ? `${androidArtifactBreakdown(android.artifact)}`
    : callout(
        'No APK/AAB was provided',
        'Project configuration is shown above. Place a release AAB/APK under android/app/build/outputs (or dist/, releases/), then run <code>npx rn-size-analyzer</code> or <code>npx rn-size-analyzer android</code>.',
        'warn',
      );

  return `${config}${artifact}${nativeTable(android)}
    ${callout(
      'AAB vs APK vs Play download',
      'AAB size is not the Play Store download size. Play generates device-specific APKs from the bundle. Use Play Console or bundletool for authoritative delivery size.',
      'info',
    )}`;
}

function iosPanel(ios: IosAnalysis): string {
  if (!ios.detected) {
    return callout('iOS not detected', esc(ios.missingReason ?? 'No iOS project found.'), 'warn');
  }

  const config = `<div class="stat-grid">
    ${stat('Deployment target', ios.build?.deploymentTarget)}
    ${stat('Hermes', ios.build?.hermesEnabled, ios.build?.hermesEnabled === undefined ? 'Not set in Podfile' : undefined)}
    ${stat('New Architecture', ios.build?.newArchEnabled)}
    ${stat('CocoaPods', ios.pods.length)}
    ${stat('Xcode project', ios.workspaceOrProject)}
    ${stat('Bundle ID', ios.build?.bundleIdentifier)}
    ${stat('Architectures', ios.build?.architectures.length ? ios.build.architectures.join(', ') : 'Not specified')}
    ${stat('Signing settings', ios.build?.signingRelatedFound ? 'Found' : 'Not found')}
    ${stat('Configurations', ios.build?.configurations.length ? ios.build.configurations.join(', ') : 'Not parsed')}
  </div>`;

  const artifact = ios.artifact
    ? `<div class="stat-grid">
        ${stat(ios.artifact.kind.toUpperCase() + ' on-disk size', formatBytesExact(ios.artifact.archiveBytes), ios.artifact.filePath)}
        ${stat('App binary', ios.artifact.appBinaryBytes ? formatBytes(ios.artifact.appBinaryBytes) : 'Not identified')}
        ${stat('Frameworks', formatBytes(ios.artifact.frameworks.reduce((sum, item) => sum + item.bytes, 0)))}
        ${stat('JS bundle', ios.artifact.jsBundle ? formatBytes(ios.artifact.jsBundle.bytes) : 'Not found')}
        ${stat('Listed assets', formatBytes(ios.artifact.assets.reduce((sum, asset) => sum + asset.bytes, 0)))}
      </div>
      ${callout('IPA size is not the App Store download size', esc(ios.artifact.thinningNote), 'info')}`
    : callout(
        'No IPA was provided',
        'Project configuration is shown above. Place a release IPA under ios/ (or dist/, releases/), then run <code>npx rn-size-analyzer</code> or <code>npx rn-size-analyzer ios</code>.',
        'warn',
      );

  const pods = podsCard(ios.pods);

  const frameworks = ios.artifact?.frameworks.length
    ? tableWrap(`<table>
        <thead><tr><th>Framework</th><th>Size</th><th>Attribution</th></tr></thead>
        <tbody>${ios.artifact.frameworks
          .slice(0, 30)
          .map(
            (item) =>
              `<tr><td>${esc(item.name)}</td><td>${formatBytes(item.bytes)}</td><td>${esc(item.attributedPackage ?? item.attributionNote ?? 'Could not confidently attribute this binary.')}</td></tr>`,
          )
          .join('')}</tbody>
      </table>`)
    : '';

  return `${config}${artifact}${frameworks}${pods}`;
}

function androidArtifactBreakdown(artifact: AndroidArtifactAnalysis): string {
  const packedRows = artifact.packed
    .map(
      (row) =>
        `<tr><td>${esc(row.label)}</td><td>${formatBytesExact(row.compressedBytes)}</td></tr>`,
    )
    .join('');
  const packedCompressed = artifact.packed.reduce((sum, row) => sum + row.compressedBytes, 0);
  const abiRows = artifact.nativeByAbi
    .map(
      (row) =>
        `<tr><td>${esc(row.abi)}</td><td>${row.libraryCount}</td><td>${formatBytesExact(row.compressedBytes)}</td></tr>`,
    )
    .join('');

  return `<div class="stat-grid">
      ${stat(
        `${artifact.kind.toUpperCase()} file size on disk`,
        formatBytesExact(artifact.archiveBytes),
        'Exact file size — matches what you see in Finder / ls.',
      )}
      ${stat('CPU ABIs bundled', artifact.abis.join(', ') || 'None')}
    </div>
    <p class="muted" style="word-break:break-all">File: <code>${esc(artifact.filePath)}</code></p>
    ${deviceEstimateBlock(artifact)}
    <h3 class="block-title">What is inside the ${artifact.kind.toUpperCase()}</h3>
    ${tableWrap(`<table>
      <thead><tr><th>Category</th><th>Size in zip</th></tr></thead>
      <tbody>${packedRows}
        <tr><td><strong>Zip entries total</strong></td><td><strong>${formatBytesExact(packedCompressed)}</strong></td></tr>
        <tr><td><strong>Actual file on disk</strong></td><td><strong>${formatBytesExact(artifact.archiveBytes)}</strong></td></tr>
      </tbody>
    </table>`)}
    <p class="muted">Zip entries total can differ from the on-disk file due to zip headers/central directory overhead.</p>
    <h3 class="block-title">Native libraries by CPU type</h3>
    ${tableWrap(`<table>
      <thead><tr><th>CPU type (ABI)</th><th>Libraries</th><th>In zip</th></tr></thead>
      <tbody>${abiRows}</tbody>
    </table>`)}
    ${callout(
      'Play Store download size is not measured here',
      'Play Console is the source of truth for what users download. This tool cannot read Play Console and must not replace that number.',
      'warn',
    )}`;
}

function deviceEstimateBlock(artifact: AndroidArtifactAnalysis): string {
  const estimate = artifact.deviceEstimate;
  if (!estimate) {
    return callout(
      'Play Store download size is unknown',
      'This tool does not query Google Play. Use Play Console or <code>bundletool get-size total</code> for the real device download size.',
      'warn',
    );
  }
  return `<div class="card" style="margin:12px 0;background:#fff7ed;border-color:#fdba74">
    <h3 class="block-title" style="margin-top:0">Not the Play Store size</h3>
    <p>Play Console download size is authoritative. This tool <strong>does not</strong> know that number and did not measure a Play download size.</p>
    <p>The optional zip heuristic below only drops other CPU ABIs. It still includes every language and drawable density, and it uses zip compression, not Play delivery compression. That is why it can be much larger than Play Console (for example ~90 MB heuristic vs ~41 MB on Play).</p>
    <div class="stat-grid">
      ${stat('Method', 'ABI zip heuristic')}
      ${stat('ABI kept', estimate.preferredAbi)}
      ${stat('Shared files (zip compressed)', formatBytesExact(estimate.sharedCompressedBytes))}
      ${stat(`${estimate.preferredAbi} native (zip compressed)`, formatBytesExact(estimate.nativePreferredCompressedBytes))}
      ${stat('Heuristic total', formatBytesExact(estimate.includedCompressedBytes), 'Not Play Store')}
      ${stat('Other ABIs excluded', formatBytesExact(estimate.excludedOtherAbiCompressedBytes))}
    </div>
    <ul class="cause-list">${estimate.limitations.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
    <p class="muted">For the real number: Play Console → App bundle explorer / download size, or <code>bundletool get-size total --apks=app.apks</code>.</p>
  </div>`;
}

function nativeTable(android: AndroidAnalysis): string {
  if (!android.artifact?.nativeLibraries.length) return '';
  const rows = android.artifact.nativeLibraries
    .slice()
    .sort((a, b) => (b.compressedBytes ?? b.uncompressedBytes) - (a.compressedBytes ?? a.uncompressedBytes))
    .slice(0, 40)
    .map(
      (lib) =>
        `<tr><td>${esc(lib.name)}</td><td>${esc(lib.abi ?? '—')}</td><td>${formatBytes(lib.compressedBytes ?? 0)}</td><td>${formatBytes(lib.uncompressedBytes)}</td><td>${esc(lib.attributedPackage ?? 'Could not confidently attribute this binary.')}</td></tr>`,
    )
    .join('');
  return `<h3 class="block-title">Largest native libraries</h3>
    ${tableWrap(`<table><thead><tr><th>Library</th><th>ABI</th><th>Packed</th><th>Uncompressed</th><th>Likely package</th></tr></thead><tbody>${rows}</tbody></table>`)}`;
}

function renderGraph(root: string, native: string[]): string {
  const lines = [root];
  native.slice(0, 18).forEach((name, index) => {
    const last = index === Math.min(native.length, 18) - 1;
    lines.push(`${last ? '└──' : '├──'} ${name}`);
    lines.push(`${last ? '    ' : '│   '}└── native libraries / frameworks`);
  });
  if (native.length === 0) lines.push('└── (no native modules detected in node_modules)');
  return lines.join('\n');
}

function unusedJsCard(jsUnused: JsUnusedAnalysis): string {
  const bytecodeRows = jsUnused.unusedInBytecode
    .map(
      (item) => `<tr data-filter-text="${esc(`${item.name} ${item.file} ${item.kind} bytecode likely`.toLowerCase())}" data-js-kind="${esc(item.kind)}" data-js-bundle="bytecode">
        <td class="cell-name"><code title="${esc(item.name)}">${breakable(item.name)}</code></td>
        <td class="cell-kind">${esc(item.kind)}</td>
        <td class="cell-path"><code>${breakable(`${item.file}:${item.line}`)}</code></td>
        <td class="cell-status">${pill('Likely in bytecode', 'warn')}</td>
      </tr>`,
    )
    .join('');
  const unreachableRows = jsUnused.unusedUnreachableModules
    .map(
      (item) => `<tr data-filter-text="${esc(`${item.name} ${item.file} module unreached`.toLowerCase())}" data-js-kind="module" data-js-bundle="unreached">
        <td class="cell-name"><code title="${esc(item.name)}">${breakable(item.name)}</code></td>
        <td class="cell-kind">file</td>
        <td class="cell-path"><code>${breakable(item.file)}</code></td>
        <td class="cell-status">${pill('Not in JS bundle', 'muted')}</td>
      </tr>`,
    )
    .join('');
  const rows = bytecodeRows + unreachableRows;
  return `<div class="stat-grid">
      ${stat('App entry files', jsUnused.entryFiles.join(', ') || 'Not found')}
      ${stat('JS files scanned', jsUnused.scannedFileCount)}
      ${stat('Imported by the app', jsUnused.reachableModuleCount)}
      ${stat('Likely in bytecode', jsUnused.unusedInBytecode.length)}
      ${stat('Not in JS bundle', jsUnused.unusedUnreachableModules.length)}
    </div>
    <div class="legend">
      <div class="legend-item">
        <h4>${pill('Likely in bytecode', 'warn')}</h4>
        <p>This unused function or component lives in a file your app already imports. The bundler can still pack it into the JavaScript that Hermes compiles for the APK/AAB. Start here. Comment or delete it, then rebuild a release binary to see if size dropped. Exact savings are not measured here.</p>
      </div>
      <div class="legend-item">
        <h4>${pill('Not in JS bundle', 'muted')}</h4>
        <p>No app file imports this file. The bundler usually skips it, so it is probably <strong>not</strong> in the current APK/AAB JavaScript. You can delete it to clean the project. That typically does not change the current download size.</p>
      </div>
    </div>
    <div class="list-card">
      <div class="list-card-head">
        <div class="list-card-title">
          <h3>Unused JS components and functions</h3>
          <p class="muted">Scans <code>src/</code> and <code>app/</code> only. Start with Likely in bytecode, then rebuild a release AAB/APK.</p>
        </div>
        <div class="list-tools">
          <div class="seg" role="tablist" aria-label="Filter unused JS">
            <button type="button" class="active" data-js-filter="all">All (${jsUnused.unusedInBytecode.length + jsUnused.unusedUnreachableModules.length})</button>
            <button type="button" data-js-filter="bytecode">Likely in bytecode (${jsUnused.unusedInBytecode.length})</button>
            <button type="button" data-js-filter="unreached">Not in JS bundle (${jsUnused.unusedUnreachableModules.length})</button>
            <button type="button" data-js-filter="component">Components</button>
            <button type="button" data-js-filter="function">Functions</button>
          </div>
          <input class="list-search" data-filter="js-unused-list" type="search" placeholder="Filter name or file" aria-label="Filter unused JS"/>
        </div>
      </div>
      <div class="list-scroll">
        <table id="js-unused-list" class="js-unused-table">
          <thead><tr><th>Name</th><th>Kind</th><th>Location</th><th>Status</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4">No unused JS components or functions found in src/ or app/.</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

export function renderHtml(analysis: ProjectAnalysis): string {
  const data = JSON.stringify(analysis).replace(/</g, '\\u003c');
  const { overview, health, issues, android, ios, release, dependencies, assets, recommendations, jsUnused } =
    analysis;
  const analyzedPlatform = analysis.analyzedPlatform ?? 'all';
  const showAndroid = analyzedPlatform !== 'ios';
  const showIos = analyzedPlatform !== 'android';
  const nativeTab = showAndroid ? 'android' : showIos ? 'ios' : 'overview';
  const visibleIssues = issues.filter((item) => {
    if (!showAndroid && item.platform === 'android') return false;
    if (!showIos && item.platform === 'ios') return false;
    return true;
  });

  const catCount = (category: Issue['category']) => visibleIssues.filter((item) => item.category === category).length;
  const counts = {
    warning: visibleIssues.filter((item) => item.severity === 'warning' || item.severity === 'critical').length,
    info: visibleIssues.filter((item) => item.severity === 'info').length,
    perf: analysis.performance.findings.length,
    security: analysis.security.findings.length,
    size: catCount('size'),
    dependencies: catCount('dependencies'),
    assets: catCount('assets'),
    build: catCount('build'),
    release: catCount('release'),
  };

  const topIssues = visibleIssues.filter((item) => item.severity !== 'passed').slice(0, 12);
  const issueCards = topIssues.map(issueCard).join('\n');
  const issuesFor = (category: Issue['category'], platform: Issue['platform']) =>
    visibleIssues.filter((item) => item.category === category && item.platform === platform);
  const androidSizeIssues = issuesFor('size', 'android');
  const iosSizeIssues = issuesFor('size', 'ios');
  const androidBuildIssues = issuesFor('build', 'android');
  const iosBuildIssues = issuesFor('build', 'ios');
  const dependencyIssues = visibleIssues.filter((item) => item.category === 'dependencies');
  const assetIssues = visibleIssues.filter((item) => item.category === 'assets');
  const perfIssues = visibleIssues.filter((item) => item.category === 'performance');
  const securityIssues = visibleIssues.filter((item) => item.category === 'security');
  const releaseIssues = visibleIssues.filter((item) => item.category === 'release');
  const recCards = recommendations
    .map(
      (item) => `<article class="issue">
        <div class="issue-top">${pill('Recommendation', 'ok')} ${pill(item.confidence, 'muted')}</div>
        <h3>${esc(item.title)}</h3>
        <div class="issue-grid">
          <div class="span-2"><span>Why</span><div>${esc(item.why)}</div></div>
          <div class="span-2"><span>Impact</span><div>${esc(item.impact)}</div></div>
          <div class="span-2 reco"><span>What to check</span><ol>${item.whatToCheck.map((check) => `<li>${esc(check)}</li>`).join('')}</ol></div>
        </div>
        <p class="muted">This tool never modifies Gradle or Pod files.</p>
      </article>`,
    )
    .join('');

  const depRows = dependencies.nodes
    .slice()
    .sort(
      (a, b) =>
        (b.androidBytes ?? 0) + (b.iosBytes ?? 0) - ((a.androidBytes ?? 0) + (a.iosBytes ?? 0)),
    )
    .map(
      (node) => `<tr data-dep="${esc(node.name)}" class="dep-row">
        <td><strong>${esc(node.name)}</strong></td>
        <td>${esc(node.version ?? '—')}</td>
        <td>${esc(node.platforms.join(', ') || 'shared')}</td>
        <td>${node.native ? pill('Native', 'warn') : pill('JS', 'muted')}</td>
        ${showAndroid ? `<td>${node.androidBytes !== undefined ? formatBytes(node.androidBytes) : '—'}</td>` : ''}
        ${showIos ? `<td>${node.iosBytes !== undefined ? formatBytes(node.iosBytes) : '—'}</td>` : ''}
      </tr>`,
    )
    .join('');

  const usagePill = (usage: string) =>
    usage === 'used' ? pill('Used', 'ok') : usage === 'unused' ? pill('Unused', 'warn') : pill('Unknown', 'muted');

  const sortedAssets = [...assets.entries].sort((a, b) => {
    const rank = (usage: string) => (usage === 'unused' ? 0 : usage === 'unknown' ? 1 : 2);
    const delta = rank(a.usage) - rank(b.usage);
    return delta !== 0 ? delta : b.bytes - a.bytes;
  });

  const assetRows = sortedAssets
    .map(
      (asset) => `<tr data-filter-text="${esc(`${asset.path} ${asset.kind} ${asset.usage} ${asset.usedIn.join(' ')}`.toLowerCase())}" data-usage="${esc(asset.usage)}">
        <td><code title="${esc(asset.path)}">${esc(asset.path)}</code></td>
        <td>${esc(asset.kind)}</td>
        <td>${formatBytes(asset.bytes)}</td>
        <td>${usagePill(asset.usage)}</td>
        <td>${asset.usedIn.length ? asset.usedIn.map((loc) => `<code>${esc(loc)}</code>`).join('<br>') : `<span class="muted">${esc(asset.usageNote)}</span>`}</td>
        <td>${esc(asset.recommendation ?? 'No automatic savings estimate')}</td>
      </tr>`,
    )
    .join('');

  const comparison = analysis.comparison
    ? `<div class="stat-grid">
        ${stat('Before', formatBytes(analysis.comparison.total.beforeBytes))}
        ${stat('After', formatBytes(analysis.comparison.total.afterBytes))}
        ${stat('Change', `${formatBytes(analysis.comparison.total.deltaBytes)} (${formatPercent(analysis.comparison.total.percentChange)})`)}
      </div>
      <h3 class="block-title">Likely causes of change</h3>
      <ul class="cause-list">${analysis.comparison.likelyCauses
        .map(
          (cause) =>
            `<li><strong>${esc(cause.title)}</strong> ${pill(cause.confidence, 'muted')}<p>${cause.evidence.map(esc).join(' · ')}</p></li>`,
        )
        .join('')}</ul>
      ${tableWrap(`<table><thead><tr><th>File</th><th>Before</th><th>After</th><th>Delta</th></tr></thead><tbody>
        ${analysis.comparison.largestChangedFiles
          .slice(0, 20)
          .map(
            (file) =>
              `<tr><td><code>${esc(file.path)}</code></td><td>${formatBytes(file.beforeBytes)}</td><td>${formatBytes(file.afterBytes)}</td><td>${formatBytes(file.deltaBytes)}</td></tr>`,
          )
          .join('')}
      </tbody></table>`)}`
    : callout(
        'No comparison in this run',
        'This report is for the current project only. Place release AAB/APK and IPA files in the project so they are auto-detected, then run <code>npx rn-size-analyzer</code>.',
        'info',
      );

  const perfRows = analysis.performance.findings
    .slice(0, 40)
    .map(
      (finding) => `<tr>
        <td><code>${esc(finding.ruleId)}</code></td>
        <td><code>${esc(finding.file)}</code></td>
        <td>${finding.line}</td>
        <td>${sev(finding.severity)}</td>
        <td>${esc(finding.explanation)}</td>
        <td>${esc(finding.recommendation)}</td>
      </tr>`,
    )
    .join('');

  const secRows = analysis.security.findings
    .slice(0, 40)
    .map(
      (finding) => `<tr>
        <td><code>${esc(finding.ruleId)}</code></td>
        <td><code>${esc(finding.file)}:${finding.line}</code></td>
        <td>${sev(finding.severity)}</td>
        <td>${esc(finding.explanation)}</td>
        <td><code>${esc(finding.snippet)}</code></td>
      </tr>`,
    )
    .join('');

  const graph = renderGraph(dependencies.graph.root, dependencies.nativeModules.map((node) => node.name));
  const overallTone = scoreTone(health.overall);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>rn-size-analyzer · ${esc(overview.name)}</title>
  <style>
    :root {
      --bg: #f6f7f9;
      --paper: #ffffff;
      --ink: #111827;
      --muted: #6b7280;
      --line: #e5e7eb;
      --ok: #047857;
      --ok-bg: #ecfdf5;
      --warn: #b45309;
      --warn-bg: #fffbeb;
      --crit: #b91c1c;
      --crit-bg: #fef2f2;
      --info: #1d4ed8;
      --info-bg: #eff6ff;
      --header: #0f172a;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.55 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #f3f4f6; padding: 1px 5px; border-radius: 4px; word-break: break-all; }
    header.app { background: var(--header); color: #f8fafc; padding: 28px 32px 20px; }
    header.app h1 { margin: 0; font-size: 18px; font-weight: 700; letter-spacing: .02em; }
    .hero { display: flex; gap: 28px; align-items: center; margin-top: 18px; flex-wrap: wrap; }
    .ring { width: 92px; height: 92px; border-radius: 50%; display: grid; place-items: center; background: conic-gradient(${
      overallTone === 'ok' ? '#34d399' : overallTone === 'warn' ? '#fbbf24' : '#f87171'
    } calc(${health.overall} * 1%), #1e293b 0); flex-shrink: 0; }
    .ring span { width: 68px; height: 68px; border-radius: 50%; background: var(--header); display: grid; place-items: center; font-size: 24px; font-weight: 800; }
    .hero h2 { margin: 0 0 6px; font-size: 22px; }
    .meta { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
    .muted { color: var(--muted); }
    .pill { display: inline-flex; align-items: center; border-radius: 999px; padding: 3px 9px; font-size: 11px; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; background: #e5e7eb; color: #374151; }
    .pill.ok { background: var(--ok-bg); color: var(--ok); }
    .pill.warn { background: var(--warn-bg); color: var(--warn); }
    .pill.crit { background: var(--crit-bg); color: var(--crit); }
    .pill.muted { background: #f3f4f6; color: #6b7280; }
    .pill.neutral { background: #e0e7ff; color: #3730a3; }
    .pill.light { background: #1e293b; color: #e2e8f0; }
    .pill.plain, .legend-item .pill { text-transform: none; letter-spacing: 0; font-size: 12px; }
    .legend { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0 0 16px; }
    .legend-item { background: #f8fafc; border: 1px solid var(--line); border-radius: 12px; padding: 12px 14px; }
    .legend-item h4 { margin: 0 0 8px; font-size: 13px; }
    .legend-item p { margin: 0; color: #4b5563; font-size: 13px; line-height: 1.5; }
    nav { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 32px; background: #1e293b; position: sticky; top: 0; z-index: 3; }
    nav button { background: transparent; color: #cbd5e1; border: 1px solid #334155; border-radius: 999px; padding: 7px 12px; cursor: pointer; font: inherit; }
    nav button.active { background: #fff; color: #0f172a; border-color: #fff; font-weight: 700; }
    main { padding: 24px 32px 72px; max-width: 1180px; margin: 0 auto; }
    .panel { display: none; }
    .panel.active { display: block; }
    .section-head { margin: 28px 0 12px; }
    .section-head h2 { margin: 0 0 4px; font-size: 18px; }
    .score-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .score-card, .card { background: var(--paper); border: 1px solid var(--line); border-radius: 14px; padding: 16px; min-width: 0; overflow-x: hidden; }
    button.score-card { appearance: none; display: block; width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer; }
    button.score-card:hover { border-color: #94a3b8; box-shadow: 0 6px 16px rgba(15, 23, 42, .08); }
    button.score-card:focus-visible { outline: 2px solid #6366f1; outline-offset: 2px; }
    .score-card-top { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
    .score-card h3 { margin: 0; font-size: 13px; color: var(--muted); font-weight: 600; }
    .score-num { font-size: 32px; font-weight: 800; margin: 8px 0 4px; letter-spacing: -.03em; }
    .score-denom { font-size: 14px; font-weight: 650; color: var(--muted); letter-spacing: 0; }
    .score-hint { margin: 0 0 10px; font-size: 12px; color: var(--muted); }
    .score-status { font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .score-findings { margin-bottom: 12px; }
    .score-findings h3 { margin: 0 0 8px; font-size: 14px; }
    .score-findings .findings-view { margin-bottom: 10px; }
    .score-findings ul { margin: 0; padding-left: 18px; display: grid; gap: 6px; }
    .score-findings li { line-height: 1.45; }
    .finding-row { display: grid; gap: 4px; }
    .finding-copy { color: #374151; }
    .tone-ok { border-top: 3px solid var(--ok); }
    .tone-warn { border-top: 3px solid var(--warn); }
    .tone-crit { border-top: 3px solid var(--crit); }
    .bar { height: 6px; background: #e5e7eb; border-radius: 99px; overflow: hidden; }
    .tone-ok .bar span { background: var(--ok); display: block; height: 100%; }
    .tone-warn .bar span { background: var(--warn); display: block; height: 100%; }
    .tone-crit .bar span { background: var(--crit); display: block; height: 100%; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 10px; margin: 0 0 16px; }
    .stat { background: #f8fafc; border: 1px solid var(--line); border-radius: 12px; padding: 12px; min-width: 0; max-width: 100%; overflow: hidden; }
    .stat-label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    .stat-value { display: block; max-width: 100%; font-size: 15px; font-weight: 700; line-height: 1.35; white-space: normal; overflow-wrap: anywhere; word-break: break-all; }
    .stat-hint { display: block; color: var(--muted); font-size: 11px; margin-top: 4px; overflow-wrap: anywhere; word-break: break-all; }
    .callout { border-radius: 12px; padding: 12px 14px; margin: 12px 0 16px; }
    .callout p { margin: 6px 0 0; }
    .callout.info { background: var(--info-bg); color: #1e3a8a; }
    .callout.warn { background: var(--warn-bg); color: #92400e; }
    .issue { background: var(--paper); border: 1px solid var(--line); border-radius: 14px; padding: 16px; margin: 0 0 12px; }
    .sev-border-critical { border-left: 4px solid var(--crit); }
    .sev-border-warning { border-left: 4px solid var(--warn); }
    .sev-border-info { border-left: 4px solid var(--info); }
    .issue-top { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
    .issue h3 { margin: 0 0 6px; font-size: 16px; }
    .issue-desc { margin: 0 0 12px; color: #374151; }
    .issue-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 16px; }
    .issue-grid span { display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin-bottom: 4px; }
    .span-2 { grid-column: 1 / -1; }
    .reco { background: var(--ok-bg); border-radius: 10px; padding: 10px 12px; }
    .evidence { display: flex; flex-direction: column; gap: 4px; }
    .sev { text-transform: uppercase; font-size: 11px; font-weight: 800; letter-spacing: .04em; padding: 2px 8px; border-radius: 99px; }
    .sev.critical { background: var(--crit-bg); color: var(--crit); }
    .sev.warning { background: var(--warn-bg); color: var(--warn); }
    .sev.info { background: var(--info-bg); color: var(--info); }
    .sev.passed { background: var(--ok-bg); color: var(--ok); }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--paper); }
    table { width: 100%; border-collapse: collapse; min-width: 640px; }
    table.compact { min-width: 0; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { font-size: 12px; color: var(--muted); background: #f8fafc; position: sticky; top: 0; }
    .list-card { border: 1px solid var(--line); border-radius: 14px; background: var(--paper); overflow: hidden; margin: 16px 0 0; }
    .list-card-head { display: grid; gap: 12px; padding: 16px 18px 14px; border-bottom: 1px solid var(--line); }
    .list-card-title h3 { margin: 0; font-size: 15px; font-weight: 750; }
    .list-card-title p { margin: 4px 0 0; font-size: 12px; }
    .list-tools { display: flex; gap: 10px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .seg { display: inline-flex; flex-wrap: nowrap; gap: 2px; background: #f3f4f6; border-radius: 10px; padding: 3px; max-width: 100%; overflow-x: auto; }
    .seg button { border: 0; background: transparent; color: #4b5563; border-radius: 8px; padding: 7px 11px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; white-space: nowrap; }
    .seg button.active { background: #fff; color: #0f172a; box-shadow: 0 1px 2px rgba(15, 23, 42, .12); }
    .list-search { border: 1px solid var(--line); border-radius: 10px; padding: 8px 12px; font: inherit; width: 240px; max-width: 100%; background: #fff; margin-left: auto; }
    .list-search:focus { outline: 2px solid #c7d2fe; border-color: #6366f1; }
    .list-scroll { max-height: 440px; overflow: auto; }
    .list-scroll table { min-width: 640px; }
    .list-scroll th, .list-scroll td { padding: 11px 18px; }
    .list-scroll td code { display: inline; max-width: none; overflow-wrap: anywhere; word-break: break-word; }
    .js-unused-table { table-layout: fixed; width: 100%; min-width: 760px; }
    .js-unused-table th, .js-unused-table td { overflow: hidden; }
    .js-unused-table th:nth-child(1) { width: 26%; }
    .js-unused-table th:nth-child(2) { width: 10%; }
    .js-unused-table th:nth-child(3) { width: 42%; }
    .js-unused-table th:nth-child(4) { width: 22%; }
    .js-unused-table td { vertical-align: top; }
    .js-unused-table .cell-kind, .js-unused-table .cell-status { white-space: nowrap; }
    .js-unused-table .cell-status .pill { white-space: nowrap; }
    .js-unused-table .cell-name code, .js-unused-table .cell-path code {
      display: block;
      max-width: 100%;
      overflow-wrap: anywhere;
      word-break: break-word;
      white-space: normal;
    }
    .list-scroll tbody tr:last-child td { border-bottom: 0; }
    .list-scroll tbody tr:hover { background: #f8fafc; }
    .pod-name { font-weight: 650; overflow-wrap: anywhere; word-break: break-word; }
    .pod-specs { color: var(--muted); font-size: 12px; margin-top: 3px; line-height: 1.4; overflow-wrap: anywhere; }
    .ver { display: inline-block; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; background: #f3f4f6; color: #374151; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
    .tree { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; background: #0f172a; color: #e2e8f0; padding: 14px; border-radius: 12px; overflow: auto; margin: 12px 0; }
    ul.checks, .cause-list { list-style: none; padding: 0; margin: 0; }
    ul.checks li { display: flex; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); }
    ul.checks p, .cause-list p { margin: 4px 0 0; color: var(--muted); }
    .check-mark { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; flex-shrink: 0; background: #f3f4f6; }
    li.ready .check-mark { background: var(--ok-bg); color: var(--ok); }
    li.warning .check-mark { background: var(--warn-bg); color: var(--warn); }
    li.not-ready .check-mark { background: var(--crit-bg); color: var(--crit); }
    .dep-row { cursor: pointer; }
    .dep-row:hover { background: #f8fafc; }
    .release-badge { display: inline-block; padding: 4px 10px; border-radius: 999px; font-weight: 800; font-size: 12px; }
    .READY { background: var(--ok-bg); color: var(--ok); }
    .WARNING { background: var(--warn-bg); color: var(--warn); }
    .NOT-READY { background: var(--crit-bg); color: var(--crit); }
    .block-title { margin: 20px 0 10px; font-size: 15px; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 900px) {
      .score-grid, .issue-grid, .split { grid-template-columns: 1fr; }
      main, header.app, nav { padding-left: 16px; padding-right: 16px; }
      .list-search { width: 100%; margin-left: 0; }
      .list-tools { flex-direction: column; align-items: stretch; }
      .seg { width: 100%; }
      .legend { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="app">
    <h1>rn-size-analyzer</h1>
    <div class="hero">
      <div class="ring"><span>${health.overall}</span></div>
      <div>
        <h2>${esc(overview.name)}</h2>
        <div>Overall health score · ${esc(scoreLabel(health.overall))}</div>
        <div class="meta">
          ${pill('React Native ' + (overview.reactNativeVersion ?? 'unknown'), 'light')}
          ${pill(overview.kind, 'light')}
          ${pill(overview.packageManager, 'light')}
          ${pill(overview.nodeVersion ?? 'Node unknown', 'light')}
          ${showAndroid ? pill(overview.androidDetected ? 'Android detected' : 'No Android', overview.androidDetected ? 'ok' : 'warn') : ''}
          ${showIos ? pill(overview.iosDetected ? 'iOS detected' : 'No iOS', overview.iosDetected ? 'ok' : 'warn') : ''}
          ${pill('Hermes ' + display(overview.hermesEnabled, 'unknown'), overview.hermesEnabled ? 'ok' : 'muted')}
          ${pill('New Arch ' + display(overview.newArchEnabled, 'unknown'), overview.newArchEnabled ? 'ok' : 'muted')}
        </div>
        <p class="muted">Generated ${esc(formatWhen(analysis.generatedAt))} · v${esc(analysis.toolVersion)} · ${counts.warning} warnings · ${counts.info} info</p>
      </div>
    </div>
  </header>
  <nav>
    <button data-tab="overview" class="active">Overview</button>
    ${showAndroid ? '<button data-tab="android">Android</button>' : ''}
    ${showIos ? '<button data-tab="ios">iOS</button>' : ''}
    <button data-tab="deps">Dependencies (${dependencies.totalDirect})</button>
    <button data-tab="assets">Assets</button>
    <button data-tab="js-unused">JS unused (${(jsUnused.unusedInBytecode.length + jsUnused.unusedUnreachableModules.length) || 0})</button>
    <button data-tab="perf">Performance (${counts.perf})</button>
    <button data-tab="security">Security (${counts.security})</button>
    <button data-tab="release">Release</button>
    ${analysis.comparison ? '<button data-tab="compare">Compare</button>' : ''}
  </nav>
  <main>
    <section class="panel active" id="overview">
      <div class="score-grid">
        ${scoreCard('Size', health.size, nativeTab, counts.size)}
        ${scoreCard('Dependencies', health.dependencies, 'deps', counts.dependencies)}
        ${scoreCard('Assets', health.assets, 'assets', counts.assets)}
        ${scoreCard('Performance', health.performance, 'perf', counts.perf)}
        ${scoreCard('Security', health.security, 'security', counts.security)}
        ${scoreCard('Build', health.build, nativeTab, counts.build)}
        ${scoreCard('Release', health.release, 'release', counts.release)}
      </div>
      ${callout(
        'These cards are scores, not issue counts',
        'Each number is a health score from 0 to 100 (100 is best). It starts at 100, then subtracts 25 per critical finding, 10 per warning, and 3 per info item in that area. A 0 means the score hit the floor — it does not mean “nothing found”. The tab badge (for example Security (10)) is the finding count. Click a card to open that section.',
        'info',
      )}
      <div class="section-head">
        <h2>Top issues</h2>
        <p class="muted">Each issue is shown as problem, evidence, impact, then what to do. Estimates are labeled. This dashboard works without a server.</p>
      </div>
      ${issueCards || '<p>No issues reported.</p>'}
      <div class="section-head">
        <h2>What to check next</h2>
      </div>
      ${recCards || callout('No native-size recommendations yet', 'Analyze an APK, AAB, or IPA to attribute native binaries to packages.', 'info')}
    </section>
    ${showAndroid ? `<section class="panel" id="android">
      <div class="section-head">
        <h2>Android</h2>
        <p class="muted">Size and build details for the Android project and the packaged AAB/APK. Size score starts at 100 and drops when native libraries, ABIs, or archive findings are flagged. Build score uses Gradle/project issues such as missing config.</p>
      </div>
      ${scoreFindingsBlock('Findings counted in Size score', androidSizeIssues)}
      ${scoreFindingsBlock('Findings counted in Build score', androidBuildIssues)}
      <div class="card">${androidPanel(android)}</div>
    </section>` : ''}
    ${showIos ? `<section class="panel" id="ios">
      <div class="section-head">
        <h2>iOS</h2>
        <p class="muted">Xcode / CocoaPods configuration and the packaged IPA/.app. Size score findings for frameworks and archive size stay here. Build score uses Xcode/Pods issues.</p>
      </div>
      ${scoreFindingsBlock('Findings counted in Size score', iosSizeIssues)}
      ${scoreFindingsBlock('Findings counted in Build score', iosBuildIssues)}
      <div class="card">${iosPanel(ios)}</div>
    </section>` : ''}
    <section class="panel" id="deps">
      <div class="section-head">
        <h2>Dependencies</h2>
        <p class="muted">Direct npm packages and native modules. The Dependencies score starts at 100 and drops when a package is estimated to add a large native .so payload. Click a row for package details. Attribution is a name match, not a Play download size.</p>
      </div>
      ${scoreFindingsBlock('Findings counted in Dependencies score', dependencyIssues)}
      <div class="stat-grid">
        ${stat('Direct packages', dependencies.totalDirect)}
        ${stat('Transitive (lockfile)', dependencies.totalTransitive ?? 'Unknown')}
        ${stat('Native modules', dependencies.nativeModules.length)}
        ${stat('Package manager', dependencies.packageManager)}
      </div>
      ${callout('Native sizes are estimates', 'Android/iOS bytes are attributed from binary names when possible. If a cell is empty, the tool could not confidently attribute that binary.', 'info')}
      <div class="tree">${esc(graph)}</div>
      ${tableWrap(`<table><thead><tr><th>Package</th><th>Version</th><th>Platforms</th><th>Type</th>${showAndroid ? '<th>Android</th>' : ''}${showIos ? '<th>iOS</th>' : ''}</tr></thead><tbody>${depRows}</tbody></table>`)}
      <div id="dep-detail" class="muted" style="margin-top:12px">Click a package row for details.</div>
    </section>
    <section class="panel" id="assets">
      <div class="section-head">
        <h2>Assets & fonts</h2>
        <p class="muted">Images, fonts, and media scanned from the project. The Assets score starts at 100 and drops for large, unused, or duplicate files. Unused is a static search — confirm before deleting. Sizes are source/archive sizes, not Play download size.</p>
      </div>
      ${scoreFindingsBlock('Findings counted in Assets score', assetIssues)}
      <div class="stat-grid">
        ${stat('Scanned size', formatBytes(assets.totalBytes))}
        ${stat('Files scanned', assets.entries.length)}
        ${stat('Used', assets.usedCount ?? 0)}
        ${stat('Unused', assets.unusedCount ?? 0, assets.unusedBytes ? formatBytes(assets.unusedBytes) : undefined)}
        ${stat('Unknown', assets.unknownCount ?? 0)}
        ${stat('Fonts', assets.fonts.length)}
        ${stat('Duplicate groups', assets.duplicates.length)}
      </div>
      ${callout(
        'Usage is a static search, not a guarantee',
        'Used means a require/import/resource string matched this filename. Unused means no static match was found. Dynamic paths can still load a file. Search the repo before deleting.',
        'info',
      )}
      <div class="list-card">
        <div class="list-card-head">
          <div class="list-card-title">
            <h3>All scanned assets</h3>
            <p class="muted">Sorted unused first, then by size. ${assets.entries.length} files.</p>
          </div>
          <div class="list-tools">
            <div class="seg" role="tablist" aria-label="Filter by usage">
              <button type="button" class="active" data-usage-filter="all">All (${assets.entries.length})</button>
              <button type="button" data-usage-filter="used">Used (${assets.usedCount ?? 0})</button>
              <button type="button" data-usage-filter="unused">Unused (${assets.unusedCount ?? 0})</button>
              <button type="button" data-usage-filter="unknown">Unknown (${assets.unknownCount ?? 0})</button>
            </div>
            <input class="list-search" data-filter="assets-list" type="search" placeholder="Filter path or file" aria-label="Filter assets"/>
          </div>
        </div>
        <div class="list-scroll">
          <table id="assets-list">
            <thead><tr><th>Path</th><th>Kind</th><th>Size</th><th>Usage</th><th>Referenced from</th><th>Recommendation</th></tr></thead>
            <tbody>${assetRows || '<tr><td colspan="6">No scanned assets.</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </section>
    <section class="panel" id="js-unused">
      <div class="section-head"><h2>Unused JavaScript</h2><p class="muted">Finds unused components and functions in your app source. It does not measure exact Hermes bytecode bytes.</p></div>
      ${unusedJsCard(jsUnused)}
    </section>
    <section class="panel" id="perf">
      <div class="section-head">
        <h2>Performance static analysis</h2>
        <p class="muted">The Performance score starts at 100 and drops for each rule hit (inline objects, missing keys, verbose logs, and similar). This is not a runtime profiler. Rules can false-positive. Fix the rows that match real product code.</p>
      </div>
      ${scoreFindingsBlock('Findings counted in Performance score', perfIssues)}
      ${tableWrap(`<table><thead><tr><th>Rule</th><th>File</th><th>Line</th><th>Severity</th><th>Explanation</th><th>Recommendation</th></tr></thead>
        <tbody>${perfRows || '<tr><td colspan="6">No findings.</td></tr>'}</tbody></table>`)}
    </section>
    <section class="panel" id="security">
      <div class="section-head">
        <h2>Security</h2>
        <p class="muted">The Security card is a health score from 0 to 100, not a count. It starts at 100. Each warning subtracts 10, each critical 25. ${counts.security} finding(s) in this report ${health.security === 0 ? 'pulled the score to 0' : `give a score of ${health.security}`}. The tab badge (${counts.security}) is how many pattern matches were found. These are regex matches (HTTP URLs, API-key shapes, private keys), not proof of a live leak — except a PEM private key block, which is high confidence.</p>
      </div>
      ${scoreFindingsBlock('Findings counted in Security score', securityIssues)}
      ${tableWrap(`<table><thead><tr><th>Rule</th><th>Location</th><th>Severity</th><th>Explanation</th><th>Snippet</th></tr></thead>
        <tbody>${secRows || '<tr><td colspan="5">No findings.</td></tr>'}</tbody></table>`)}
    </section>
    <section class="panel" id="release">
      <div class="section-head">
        <h2>Release readiness <span class="release-badge ${esc(release.overall.replace(' ', '-'))}">${esc(release.overall)}</span></h2>
        <p class="muted">${
          showAndroid && showIos
            ? 'Checklist for shipping Android and iOS.'
            : showAndroid
              ? 'Checklist for shipping Android.'
              : 'Checklist for shipping iOS.'
        } The Release score starts at 100 and drops when minify, signing, Hermes, or similar release settings look risky. This tool never changes Gradle or Pod files.</p>
      </div>
      ${scoreFindingsBlock('Findings counted in Release score', releaseIssues)}
      <div class="split">
        ${showAndroid ? `<div class="card"><h3>Android</h3>${checklist(release.android)}</div>` : ''}
        ${showIos ? `<div class="card"><h3>iOS</h3>${checklist(release.ios)}</div>` : ''}
      </div>
    </section>
    ${analysis.comparison ? `<section class="panel" id="compare">
      <div class="section-head"><h2>Release comparison</h2></div>
      <div class="card">${comparison}</div>
    </section>` : ''}
  </main>
  <script>
    const ANALYSIS = ${data};
    function showTab(tab) {
      if (!tab) return;
      const panel = document.getElementById(tab);
      const navBtn = document.querySelector('nav button[data-tab="' + tab + '"]');
      if (!panel || !navBtn) return;
      document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
      navBtn.classList.add('active');
      panel.classList.add('active');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      const heading = panel.querySelector('h2');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    }
    document.querySelectorAll('nav button').forEach((btn) => {
      btn.addEventListener('click', () => showTab(btn.dataset.tab));
    });
    document.querySelectorAll('[data-goto-tab]').forEach((btn) => {
      btn.addEventListener('click', () => showTab(btn.getAttribute('data-goto-tab')));
    });
    function applyTableFilters() {
      const usage = document.querySelector('[data-usage-filter].active')?.getAttribute('data-usage-filter') || 'all';
      const search = document.querySelector('[data-filter="assets-list"]');
      const query = (search && search.value ? search.value : '').trim().toLowerCase();
      const table = document.getElementById('assets-list');
      if (!table) return;
      table.querySelectorAll('tbody tr').forEach((row) => {
        const haystack = row.getAttribute('data-filter-text') || row.textContent || '';
        const rowUsage = row.getAttribute('data-usage') || '';
        const usageOk = usage === 'all' || rowUsage === usage;
        const textOk = !query || haystack.includes(query);
        row.hidden = !(usageOk && textOk);
      });
    }
    function applyJsUnusedFilters() {
      const selected = document.querySelector('[data-js-filter].active')?.getAttribute('data-js-filter') || 'all';
      const search = document.querySelector('[data-filter="js-unused-list"]');
      const query = (search && search.value ? search.value : '').trim().toLowerCase();
      const table = document.getElementById('js-unused-list');
      if (!table) return;
      table.querySelectorAll('tbody tr').forEach((row) => {
        const haystack = row.getAttribute('data-filter-text') || row.textContent || '';
        const kind = row.getAttribute('data-js-kind') || '';
        const bundle = row.getAttribute('data-js-bundle') || '';
        const selectedOk =
          selected === 'all' ||
          selected === bundle ||
          selected === kind;
        const textOk = !query || haystack.includes(query);
        row.hidden = !(selectedOk && textOk);
      });
    }
    document.querySelectorAll('[data-filter]').forEach((input) => {
      input.addEventListener('input', () => {
        const target = input.getAttribute('data-filter');
        if (target === 'assets-list') {
          applyTableFilters();
          return;
        }
        if (target === 'js-unused-list') {
          applyJsUnusedFilters();
          return;
        }
        const query = input.value.trim().toLowerCase();
        const table = document.getElementById(target);
        if (!table) return;
        table.querySelectorAll('tbody tr').forEach((row) => {
          const haystack = row.getAttribute('data-filter-text') || row.textContent || '';
          row.hidden = Boolean(query) && !haystack.includes(query);
        });
      });
    });
    document.querySelectorAll('[data-usage-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-usage-filter]').forEach((other) => other.classList.remove('active'));
        btn.classList.add('active');
        applyTableFilters();
      });
    });
    document.querySelectorAll('[data-js-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-js-filter]').forEach((other) => other.classList.remove('active'));
        btn.classList.add('active');
        applyJsUnusedFilters();
      });
    });
    document.querySelectorAll('.dep-row').forEach((row) => {
      row.addEventListener('click', () => {
        const name = row.getAttribute('data-dep');
        const node = (ANALYSIS.dependencies.nodes || []).find((n) => n.name === name);
        if (!node) return;
        document.getElementById('dep-detail').innerHTML =
          '<article class="issue"><div class="issue-top"><strong>' + name + '</strong></div>' +
          '<div class="issue-grid">' +
          '<div><span>Version</span><div>' + (node.version || '—') + '</div></div>' +
          '<div><span>Platforms</span><div>' + (node.platforms || []).join(', ') + '</div></div>' +
          '<div><span>Native</span><div>' + (node.native ? 'Yes' : 'No') + '</div></div>' +
          '<div><span>Attribution</span><div>' + node.attributionConfidence + '</div></div>' +
          '<div class="span-2"><span>Dependencies</span><div>' + ((node.dependencies || []).slice(0, 20).join(', ') || '—') + '</div></div>' +
          '<div class="span-2"><span>Files</span><div>' + ((node.filesContributed || []).join(', ') || '—') + '</div></div>' +
          '<div class="span-2"><span>Notes</span><div>' + ((node.warnings || []).join(' ') || 'None') + '</div></div>' +
          '</div></article>';
      });
    });
    document.querySelectorAll('.score-findings').forEach((block) => {
      const buttons = block.querySelectorAll('[data-findings-view]');
      buttons.forEach((btn) => {
        btn.addEventListener('click', () => {
          const view = btn.getAttribute('data-findings-view') || 'summary';
          buttons.forEach((other) => other.classList.remove('active'));
          btn.classList.add('active');
          block.querySelectorAll('[data-findings-copy]').forEach((copy) => {
            const mode = copy.getAttribute('data-findings-copy');
            copy.hidden = mode !== view;
          });
        });
      });
    });
  </script>
</body>
</html>`;
}

export function writeHtmlReport(reportDir: string, analysis: ProjectAnalysis): string {
  const file = join(reportDir, 'index.html');
  writeText(file, renderHtml(analysis));
  return file;
}
