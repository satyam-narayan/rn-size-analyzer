export type Severity = 'critical' | 'warning' | 'info' | 'passed';

export type Platform = 'android' | 'ios' | 'shared' | 'unknown';

export type Confidence = 'measured' | 'high' | 'medium' | 'low' | 'unknown';

export type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun' | 'unknown';

export type ProjectKind = 'bare' | 'expo' | 'unknown';

export type OutputFormat = 'terminal' | 'html' | 'json';

export type FailOn = 'critical' | 'error' | 'warning' | 'never';

export interface Issue {
  id: string;
  severity: Severity;
  title: string;
  description: string;
  evidence: string[];
  platform: Platform;
  affected?: string;
  estimatedImpactBytes?: number;
  estimatedImpactLabel?: string;
  recommendation: string;
  confidence: Confidence;
  category:
    | 'size'
    | 'dependencies'
    | 'assets'
    | 'performance'
    | 'security'
    | 'build'
    | 'release'
    | 'js-bundle'
    | 'comparison';
}

export interface Recommendation {
  id: string;
  title: string;
  why: string;
  impact: string;
  whatToCheck: string[];
  confidence: Confidence;
  relatedIssueIds: string[];
}

export interface SizeBreakdown {
  label: string;
  bytes: number;
  compressedBytes?: number;
  note?: string;
}

export interface SizeAnalysis {
  totalBytes: number;
  compressedBytes?: number;
  breakdown: SizeBreakdown[];
  notes: string[];
}

export interface NativeLibrary {
  name: string;
  path: string;
  abi?: string;
  uncompressedBytes: number;
  compressedBytes?: number;
  attributedPackage?: string;
  attributionConfidence: Confidence;
  attributionNote?: string;
}

export interface FrameworkEntry {
  name: string;
  path: string;
  bytes: number;
  attributedPackage?: string;
  attributionConfidence: Confidence;
  attributionNote?: string;
}

export interface AndroidSdkConfig {
  compileSdk?: string;
  targetSdk?: string;
  minSdk?: string;
  ndkVersion?: string;
}

export interface AndroidBuildConfig {
  hermesEnabled?: boolean;
  newArchEnabled?: boolean;
  minifyEnabled?: boolean;
  shrinkResources?: boolean;
  debuggable?: boolean;
  abiFilters: string[];
  signingConfigPresent: boolean;
  r8OrProguardConfigured: boolean;
  gradleVersion?: string;
  buildTypes: string[];
  sourceFiles: string[];
}

export interface PackedCategory {
  label: string;
  compressedBytes: number;
  uncompressedBytes: number;
  note?: string;
}

export interface AbiBreakdown {
  abi: string;
  compressedBytes: number;
  uncompressedBytes: number;
  libraryCount: number;
}

export interface DeviceEstimate {
  method: 'abi-zip-heuristic';
  preferredAbi: string;
  includedCompressedBytes: number;
  excludedOtherAbiCompressedBytes: number;
  sharedCompressedBytes: number;
  nativePreferredCompressedBytes: number;
  limitations: string[];
}

export interface AndroidArtifactAnalysis {
  kind: 'apk' | 'aab';
  filePath: string;
  archiveBytes: number;
  uncompressedBytes: number;
  estimatedDeviceSpecificBytes?: number;
  estimatedDeviceSpecificNote: string;
  deviceEstimate?: DeviceEstimate;
  nativeLibraries: NativeLibrary[];
  nativeByAbi: AbiBreakdown[];
  packed: PackedCategory[];
  jsBundle?: { path: string; bytes: number; compressedBytes?: number; hermesLikely: boolean };
  assets: SizeBreakdown[];
  resources: SizeBreakdown[];
  dex: SizeBreakdown[];
  abis: string[];
}

export interface PlatformAnalysis {
  detected: boolean;
  missingReason?: string;
  size?: SizeAnalysis;
  issues: Issue[];
}

export interface AndroidAnalysis extends PlatformAnalysis {
  sdk?: AndroidSdkConfig;
  build?: AndroidBuildConfig;
  artifact?: AndroidArtifactAnalysis;
  manifestPackage?: string;
  applicationId?: string;
}

export interface IosBuildConfig {
  deploymentTarget?: string;
  hermesEnabled?: boolean;
  newArchEnabled?: boolean;
  architectures: string[];
  configurations: string[];
  signingRelatedFound: boolean;
  sourceFiles: string[];
  bundleIdentifier?: string;
}

export interface IosArtifactAnalysis {
  kind: 'ipa' | 'app';
  filePath: string;
  archiveBytes: number;
  uncompressedBytes: number;
  appBinaryBytes?: number;
  appBinaryName?: string;
  frameworks: FrameworkEntry[];
  jsBundle?: { path: string; bytes: number; hermesLikely: boolean };
  assets: SizeBreakdown[];
  thinningNote: string;
}

export interface IosAnalysis extends PlatformAnalysis {
  build?: IosBuildConfig;
  artifact?: IosArtifactAnalysis;
  pods: PodSummary[];
  workspaceOrProject?: string;
}

export interface PodSummary {
  name: string;
  version?: string;
  bytes?: number;
}

export interface DependencyNode {
  name: string;
  version?: string;
  platforms: Platform[];
  native: boolean;
  androidBytes?: number;
  iosBytes?: number;
  attributionConfidence: Confidence;
  dependents: string[];
  dependencies: string[];
  filesContributed: string[];
  warnings: string[];
  recommendations: string[];
}

export interface DependencyAnalysis {
  totalDirect: number;
  totalTransitive?: number;
  packageManager: PackageManager;
  nodes: DependencyNode[];
  nativeModules: DependencyNode[];
  androidOnly: string[];
  iosOnly: string[];
  crossPlatform: string[];
  outdatedLocal: Array<{ name: string; current: string; note: string }>;
  graph: DependencyGraph;
  issues: Issue[];
}

export interface DependencyGraph {
  root: string;
  edges: Array<{ from: string; to: string; kind: 'npm' | 'native' | 'pod' | 'gradle' }>;
}

export interface AssetEntry {
  path: string;
  bytes: number;
  kind: 'image' | 'font' | 'video' | 'other';
  extension: string;
  duplicateOf?: string;
  potentiallyUnused: boolean;
  usage: 'used' | 'unused' | 'unknown';
  usedIn: string[];
  usageConfidence: Confidence;
  usageNote: string;
  recommendation?: string;
}

export interface AssetAnalysis {
  totalBytes: number;
  unusedBytes: number;
  usedCount: number;
  unusedCount: number;
  unknownCount: number;
  entries: AssetEntry[];
  largest: AssetEntry[];
  duplicates: Array<{ hash: string; paths: string[]; bytes: number }>;
  fonts: FontEntry[];
  issues: Issue[];
}

export interface FontEntry {
  path: string;
  familyGuess: string;
  bytes: number;
  potentiallyUnused: boolean;
}

export interface JsBundleAnalysis {
  found: boolean;
  path?: string;
  bytes?: number;
  hermesLikely?: boolean;
  sourceMapFound?: boolean;
  largestModules: Array<{ name: string; bytes?: number; note: string }>;
  notes: string[];
  issues: Issue[];
}

export interface UnusedJsSymbol {
  name: string;
  kind: 'component' | 'function' | 'class' | 'module';
  file: string;
  line: number;
  inBundleGraph: boolean;
  likelyInBytecode: boolean;
  confidence: Confidence;
  evidence: string[];
  recommendation: string;
}

export interface JsUnusedAnalysis {
  entryFiles: string[];
  scannedFileCount: number;
  reachableModuleCount: number;
  unusedInBytecode: UnusedJsSymbol[];
  unusedUnreachableModules: UnusedJsSymbol[];
  notes: string[];
  issues: Issue[];
}

export interface PerformanceFinding {
  ruleId: string;
  file: string;
  line: number;
  severity: Severity;
  explanation: string;
  recommendation: string;
}

export interface PerformanceAnalysis {
  findings: PerformanceFinding[];
  issues: Issue[];
}

export interface SecurityFinding {
  ruleId: string;
  file: string;
  line: number;
  severity: Severity;
  snippet: string;
  explanation: string;
  recommendation: string;
}

export interface SecurityAnalysis {
  findings: SecurityFinding[];
  issues: Issue[];
}

export interface ChecklistItem {
  id: string;
  label: string;
  status: 'ready' | 'warning' | 'not-ready' | 'unknown';
  detail: string;
  platform: Platform;
}

export interface ReleaseAnalysis {
  overall: 'READY' | 'WARNING' | 'NOT READY';
  android: ChecklistItem[];
  ios: ChecklistItem[];
  issues: Issue[];
}

export interface ComparisonDelta {
  label: string;
  beforeBytes: number;
  afterBytes: number;
  deltaBytes: number;
  percentChange: number;
}

export interface ComparisonAnalysis {
  oldPath: string;
  newPath: string;
  platform: Platform;
  total: ComparisonDelta;
  breakdown: ComparisonDelta[];
  largestChangedFiles: Array<{
    path: string;
    beforeBytes: number;
    afterBytes: number;
    deltaBytes: number;
  }>;
  likelyCauses: Array<{
    title: string;
    evidence: string[];
    confidence: Confidence;
  }>;
  issues: Issue[];
}

export interface HealthScores {
  overall: number;
  size: number;
  dependencies: number;
  assets: number;
  performance: number;
  security: number;
  build: number;
  release: number;
}

export interface ProjectOverview {
  name: string;
  root: string;
  reactNativeVersion?: string;
  nodeVersion?: string;
  packageManager: PackageManager;
  kind: ProjectKind;
  androidDetected: boolean;
  iosDetected: boolean;
  hermesEnabled?: boolean;
  newArchEnabled?: boolean;
}

export interface ProjectAnalysis {
  overview: ProjectOverview;
  health: HealthScores;
  issues: Issue[];
  recommendations: Recommendation[];
  android: AndroidAnalysis;
  ios: IosAnalysis;
  dependencies: DependencyAnalysis;
  assets: AssetAnalysis;
  jsBundle: JsBundleAnalysis;
  jsUnused: JsUnusedAnalysis;
  performance: PerformanceAnalysis;
  security: SecurityAnalysis;
  release: ReleaseAnalysis;
  comparison?: ComparisonAnalysis;
  generatedAt: string;
  toolVersion: string;
}

export interface AnalyzerConfig {
  android?: {
    maxIncrease?: string;
    maxSize?: string;
  };
  ios?: {
    maxIncrease?: string;
    maxSize?: string;
  };
  failOn?: FailOn;
  ignore?: string[];
  rules?: Record<string, { enabled?: boolean; severity?: Severity }>;
  baselinePath?: string;
  reportDir?: string;
}

export interface AnalyzeOptions {
  cwd: string;
  target?: string;
  platform?: 'android' | 'ios' | 'all';
  format?: OutputFormat;
  open?: boolean;
  reportDir?: string;
  config?: AnalyzerConfig;
  silent?: boolean;
  jsonStdout?: boolean;
}

export interface CheckOptions extends AnalyzeOptions {
  maxIncrease?: string;
  maxSize?: string;
  baselinePath?: string;
  failOn?: FailOn;
}

export interface CompareOptions {
  oldPath: string;
  newPath: string;
  format?: OutputFormat;
  reportDir?: string;
  open?: boolean;
  silent?: boolean;
}

export const EXIT = {
  PASS: 0,
  THRESHOLD: 1,
  ANALYZER_ERROR: 2,
  INVALID: 3,
} as const;
