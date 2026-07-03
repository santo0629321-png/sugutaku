/**
 * すぐタク 統合コアロジック - 型定義
 * シニア向けデータ配車プラットフォーム「すぐタク」
 *
 * 設計方針:
 * - 高齢者本人の個人情報（氏名・番地・電話番号等）はこのシステムのサーバー側を
 *   一切通過しない。ネットワークを流れるのは「シニア会員ID」「匿名化済み行先エリア」
 *   「優先タクシー会社ID」のみ（第三者提供禁止の個人情報保護法をクリアする設計）。
 */

// ============================================================
// Enums
// ============================================================

/** ドライバー（タクシー車両）の稼働ステータス */
export enum DriverStatus {
  /** 空車（マッチング可能） */
  AVAILABLE = 'AVAILABLE',
  /** 実車中（他の客を乗せている、または乗せに向かっている） */
  BUSY = 'BUSY',
  /** 確定ロック済み（このリクエスト専用に固定され、以後キャンセル不可） */
  LOCKED = 'LOCKED',
  /** オフライン・非稼働 */
  OFFLINE = 'OFFLINE',
}

/** 自社マッチング内でのエントリー枠（本命・控えの2枠制） */
export enum MatchSlot {
  /** 本命（10分前に確定ロックさせる最有力枠） */
  PRIMARY = 'PRIMARY',
  /** 控え（本命離脱時に即座に昇格する予備枠） */
  SECONDARY = 'SECONDARY',
}

/** マッチングセッション全体の進行状態 */
export enum SessionStatus {
  /** 受付直後、優先（こだわり）会社のみへ通知中 */
  PENDING_PREFERRED = 'PENDING_PREFERRED',
  /** 3分経過後、エリア加盟の全社へ募集範囲を拡張して受付中 */
  PENDING_EXPANDED = 'PENDING_EXPANDED',
  /** 確定10分前ロックが完了し、自社車両で確定済み */
  LOCKED_OWN_NETWORK = 'LOCKED_OWN_NETWORK',
  /** 自社が全滅につき他社APIへ処理を委譲し、時差発注の保留時間を消化中 */
  DELEGATED_HOLDING = 'DELEGATED_HOLDING',
  /** 他社APIでの配車が確定済み */
  CONFIRMED_OTHER_API = 'CONFIRMED_OTHER_API',
  /** 乗車チケット発券・請求記録まで完了 */
  COMPLETED = 'COMPLETED',
  /** 手配不成立（内部記録のみ。薬局・患者には一切通知しない） */
  FAILED = 'FAILED',
}

/** 請求種別（すぐタクの二重収益構造） */
export enum BillingType {
  /** 自社加盟タクシーへの手数料請求 */
  OWN_COMMISSION = 'OWN_COMMISSION',
  /** 他社への潜在需要データ紹介料請求（1送客あたり固定額） */
  DATA_LEAD_FEE = 'DATA_LEAD_FEE',
}

// ============================================================
// ドメインモデル
// ============================================================

/** 匿名化済みの緯度経度（町丁目の代表点）。個人宅の座標は一切含まない */
export interface MaskedGeoPoint {
  lat: number;
  lng: number;
}

/**
 * 個人情報保護法対応：薬局レセコン内でローカル処理された後、
 * サーバーへ渡ってよい行先情報はこれだけ（番地・建物名は破棄済み）。
 */
export interface AnonymizedDestination {
  /** 町名までにマスキングされたエリア名（例: 福岡市西区元岡） */
  areaName: string;
  /** エリアの代表座標（町丁目セントロイド）。個人宅の座標ではない */
  point: MaskedGeoPoint;
}

/** タクシー車両・ドライバー情報 */
export interface Driver {
  driverId: string;
  driverName: string;
  companyId: string;
  companyName: string;
  carColor: string;
  /** ナンバープレート下4桁 */
  licensePlateLast4: string;
  status: DriverStatus;
}

/** 薬局端末（レセコン連携ボタン）から発生する事前配車リクエストの入力 */
export interface PreDispatchRequestInput {
  /** 事前登録済みシニア会員ID（氏名等の個人情報は含まない） */
  seniorMemberId: string;
  /** シニア会員が事前登録している「こだわり」優先タクシー会社ID */
  preferredCompanyId: string;
  /** 匿名化済みの行先エリア情報 */
  destination: AnonymizedDestination;
  pharmacyId: string;
  /** 薬局の位置（運賃・距離計算の起点。個人宅ではなく薬局の公開所在地） */
  pharmacyLocation: MaskedGeoPoint;
  /** 会計完了（患者が店を出る）までの想定残り時間（分）。通常は30分想定 */
  minutesUntilCheckout: number;
}

/** 運賃・距離の予測結果 */
export interface FareEstimate {
  distanceKm: number;
  estimatedFareYen: number;
}

/** 乗車チケット（レシートプリンターで大文字発券するためのデータ） */
export interface RideTicket {
  sessionId: string;
  taxiCompanyName: string;
  carColor: string;
  licensePlate: string;
  /** 他社API経由の場合はドライバー名を省略できる */
  driverName?: string;
  fare: FareEstimate;
  issuedAt: Date;
}

/** 請求記録（二重収益構造のどちらで発生した収益かを一意に記録する） */
export interface BillingRecord {
  sessionId: string;
  billingType: BillingType;
  amountYen: number;
  /** OWN_COMMISSIONなら自社加盟タクシー会社ID、DATA_LEAD_FEEなら他社デスクID */
  billedPartyId: string;
  createdAt: Date;
}

/** マッチング成功時にのみ呼び出し元（薬局端末）へ返却される最終結果 */
export interface DispatchResult {
  sessionId: string;
  ticket: RideTicket;
  billing: BillingRecord;
}

// ============================================================
// 外部依存の抽象化（DI可能なインターフェース）
// ============================================================

/** 自社加盟タクシーのドライバー・ステータス管理基盤 */
export interface IDriverRegistry {
  /** 指定会社に所属する、現在空車のドライバー一覧を取得する */
  findAvailableDriversByCompany(companyId: string): Driver[];

  /**
   * エリア加盟の全社を対象に、現在空車のドライバー一覧を取得する。
   * excludeDriverIds に含まれるドライバー（既に通知済み）は除外する。
   */
  findAvailableDriversInArea(areaName: string, excludeDriverIds: ReadonlySet<string>): Driver[];

  /** 単一ドライバーの「今この瞬間」のステータスを取得する（ロック判定の最終確認用） */
  getStatus(driverId: string): DriverStatus;

  /**
   * ドライバーのステータス変化をリアルタイム購読する。
   * 「本命が移動中に実車化した瞬間」を検知するための仕組み。
   * 戻り値は購読解除関数（メモリリーク防止のため必ず解除すること）。
   */
  onStatusChange(driverId: string, callback: (newStatus: DriverStatus) => void): () => void;

  /** 確定ロックをかける（このリクエスト専用に固定し、以後キャンセル不可にする） */
  lockDriver(driverId: string): void;
}

/** ドライバーへのプッシュ通知・受託受付を担うゲートウェイ */
export interface INotificationGateway {
  /**
   * 候補ドライバー群へ配車オファーを一斉通知し、受託が来るたびに onAccept を呼ぶ。
   * durationMs 経過、または呼び出し元が cancel() するまで受付を継続する
   * （事前受託期間中は複数台からの受託を許容し、本命・控えの2枠を埋める）。
   */
  broadcastOffer(
    driverIds: string[],
    context: { sessionId: string; destinationAreaName: string },
    durationMs: number,
    onAccept: (driver: Driver) => void
  ): { cancel: () => void };
}

/** 他社配車結果（GO等） */
export interface OtherCompanyDispatchResult {
  carColor: string;
  licensePlateLast4: string;
  /** 他社APIの場合はドライバー名が取得できないことがある */
  driverName?: string;
  estimatedArrivalMinutes: number;
}

/** GO等、他社タクシー配車APIの抽象化 */
export interface ITaxiCompanyAPI {
  readonly providerName: string;
  /** 現在地からの到着予測時間（分）をリアルタイム取得する（時差発注の計算に使用） */
  getEstimatedArrivalMinutes(pickup: MaskedGeoPoint): Promise<number>;
  /** 実際に配車をリクエストする（時差発注の保留が明けたタイミングで呼ばれる） */
  requestDispatch(
    pickup: MaskedGeoPoint,
    destinationAreaName: string
  ): Promise<OtherCompanyDispatchResult | null>;
}

/** タイマー制御の抽象化（テスト時にフェイクタイマーへ差し替え可能にする） */
export interface IScheduler {
  setTimer(fn: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

/** 請求記録の永続化先（DB保存等を想定した抽象化） */
export interface IBillingLedger {
  record(entry: BillingRecord): void;
}

/** 運用監視・障害調査用のロガー抽象化（本番ではAPM等に接続する想定） */
export interface ILogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
