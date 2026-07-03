/**
 * SuguTakuMatchingEngine
 * ------------------------------------------------------------
 * シニア向けデータ配車プラットフォーム「すぐタク」の統合コアロジック。
 *
 * 前提となる現場実態:
 * - 地方都市は「流し」がほとんど発生せず、駅待ち・車庫待ちが中心。
 * - 空車を早めに呼びすぎると、現地到着後3分で待機メーターが回り始める。
 * - 高齢者はスマホを持たない前提のため、事前に「気配」だけを掴んでおき、
 *   ドライバー側には自由に営業させながら土壇場（10分前）で確定させる必要がある。
 *
 * 全体フロー:
 *   T-30分  ... submitPreDispatchRequest() でセッション開始。優先会社へ通知。
 *   T-27分  ... 受託がなければ加盟全社へ募集範囲を拡張（フォールバック）。
 *   T-30〜10分 ... 本命・控えが実車化したら自動リリース＆自動昇格を継続監視。
 *   T-10分  ... ロック判定。本命が空車なら確定ロック。全滅なら他社API委託へ。
 *   (他社委託時) 時差発注アルゴリズムで発注タイミングを意図的に遅らせる。
 */

import { calculateEstimatedFare } from './fare';
import {
  BillingRecord,
  BillingType,
  Driver,
  DriverStatus,
  DispatchResult,
  IBillingLedger,
  IDriverRegistry,
  ILogger,
  INotificationGateway,
  IScheduler,
  ITaxiCompanyAPI,
  OtherCompanyDispatchResult,
  PreDispatchRequestInput,
  RideTicket,
  SessionStatus,
} from './types';

// ============================================================
// 業務ルールとして固定される定数
// ============================================================

/** T_out: 会計完了（患者が外に出る）何分前に最終ロック判定を行うか（固定値） */
const T_OUT_MINUTES = 10;

/** 優先（こだわり）会社のみに独占的に通知する猶予時間。これを過ぎたら機会損失防止のため全社へ拡張する */
const FALLBACK_WINDOW_MINUTES = 3;

/**
 * 時差発注の固定バッファ（分）。
 * 高齢者が先に外へ出て「待たされている」状態を絶対に作るためのバッファ。
 * タクシー側は3分程度で待機メーターが回り始める現場実態があるため、
 * 早着させて客を待たせるのではなく、あえて2分遅らせて客を先に待たせる設計にする。
 */
const BUFFER_MINUTES = 2;

/** 他社への潜在需要データ紹介料（1送客あたり固定） */
const DATA_LEAD_FEE_YEN = 50;

/** 自社加盟タクシーへの手数料率（予測運賃に対する変動手数料）。下限は最低手数料額でカバーする */
const OWN_COMMISSION_RATE = 0.15;
const OWN_COMMISSION_MIN_YEN = 100;

// ============================================================
// セッション内部状態
// ============================================================

interface SlotEntry {
  driver: Driver;
  /** onStatusChange の購読解除関数。セッション終了時に必ず呼ぶ（メモリリーク防止） */
  unsubscribe: () => void;
}

interface DispatchSession {
  sessionId: string;
  input: PreDispatchRequestInput;
  status: SessionStatus;
  primary: SlotEntry | null;
  secondary: SlotEntry | null;
  /** 既に通知を送ったドライバーID（重複通知・重複カウントを防ぐ） */
  notifiedDriverIds: Set<string>;
  offerHandle: { cancel: () => void } | null;
  fallbackTimer: unknown;
  lockCheckTimer: unknown;
  holdTimer: unknown;
  /** T-10分のロック判定を実行する予定時刻（epoch ms）。再募集時の残り時間計算に使う */
  lockCheckpointAt: number;
  /** 成功時のみ呼び出される結果コールバック。失敗時は意図的に呼ばない */
  onResult?: (result: DispatchResult) => void;
}

let sessionSequence = 0;

// ============================================================
// マッチングエンジン本体
// ============================================================

export class SuguTakuMatchingEngine {
  private readonly sessions = new Map<string, DispatchSession>();

  constructor(
    private readonly driverRegistry: IDriverRegistry,
    private readonly notificationGateway: INotificationGateway,
    private readonly otherCompanyApi: ITaxiCompanyAPI,
    private readonly billingLedger: IBillingLedger,
    private readonly scheduler: IScheduler,
    private readonly logger: ILogger
  ) {}

  /**
   * 薬局端末（患者本人のワンタップ操作）から呼び出されるエントリーポイント。
   * ここで受け取れるのは匿名化済みの情報のみで、個人を特定できるデータは含まれない。
   */
  submitPreDispatchRequest(
    input: PreDispatchRequestInput,
    onResult?: (result: DispatchResult) => void
  ): string {
    const sessionId = `sgtk-${Date.now()}-${++sessionSequence}`;
    const lockCheckDelayMs = Math.max((input.minutesUntilCheckout - T_OUT_MINUTES) * 60_000, 0);

    const session: DispatchSession = {
      sessionId,
      input,
      status: SessionStatus.PENDING_PREFERRED,
      primary: null,
      secondary: null,
      notifiedDriverIds: new Set(),
      offerHandle: null,
      fallbackTimer: null,
      lockCheckTimer: null,
      holdTimer: null,
      lockCheckpointAt: Date.now() + lockCheckDelayMs,
      onResult,
    };
    this.sessions.set(sessionId, session);

    this.logger.info('事前配車リクエストを受理', {
      sessionId,
      areaName: input.destination.areaName,
      preferredCompanyId: input.preferredCompanyId,
    });

    // ① こだわり指定：まずはシニア客が指定した優先会社の空車のみへ最優先で通知する
    const preferredCandidates = this.driverRegistry.findAvailableDriversByCompany(input.preferredCompanyId);
    preferredCandidates.forEach((d) => session.notifiedDriverIds.add(d.driverId));

    session.offerHandle = this.notificationGateway.broadcastOffer(
      preferredCandidates.map((d) => d.driverId),
      { sessionId, destinationAreaName: input.destination.areaName },
      FALLBACK_WINDOW_MINUTES * 60_000,
      (driver) => this.handleAcceptance(session, driver)
    );

    // 優先会社が3分間受託しない場合、機会損失を防ぐため加盟全社へ募集範囲を拡張する
    session.fallbackTimer = this.scheduler.setTimer(
      () => this.expandToAllCompanies(session),
      FALLBACK_WINDOW_MINUTES * 60_000
    );

    // 確定10分前（T_out）に最終ロック判定を行うタイマーをセットする
    session.lockCheckTimer = this.scheduler.setTimer(() => {
      void this.runLockCheckpoint(session);
    }, lockCheckDelayMs);

    return sessionId;
  }

  /** テスト・運用監視用にセッション状態を参照するための読み取り専用アクセサ */
  getSessionStatus(sessionId: string): SessionStatus | undefined {
    return this.sessions.get(sessionId)?.status;
  }

  // ------------------------------------------------------------
  // ① こだわり会社指定 ＆ 段階的フォールバック
  // ------------------------------------------------------------

  /** ドライバーからの受託通知を受け取ったときの処理（本命→控えの順で枠を埋める） */
  private handleAcceptance(session: DispatchSession, driver: Driver): void {
    // 既にロック判定や他社委託に進んでいるセッションへの遅延受託は無視する（二重処理防止）
    if (this.isPastOwnNetworkWindow(session.status)) return;
    // 同一ドライバーが既に枠を保持している場合は無視（重複受託）
    if (session.primary?.driver.driverId === driver.driverId) return;
    if (session.secondary?.driver.driverId === driver.driverId) return;

    if (!session.primary) {
      session.primary = this.assignSlot(session, driver);
      this.logger.info('本命枠を確保', { sessionId: session.sessionId, driverId: driver.driverId });
    } else if (!session.secondary) {
      session.secondary = this.assignSlot(session, driver);
      this.logger.info('控え枠を確保', { sessionId: session.sessionId, driverId: driver.driverId });
      // 本命・控えの最大2台が揃ったので、これ以上の通知は不要（無駄な通知はドライバー体験を損なう）
      session.offerHandle?.cancel();
    }
    // 3台目以降の受託は「本命枠・控え枠の最大2台」ルールにより単純に無視する
  }

  /** ドライバーを枠に割り当て、実車化をリアルタイム検知するための購読を張る */
  private assignSlot(session: DispatchSession, driver: Driver): SlotEntry {
    const unsubscribe = this.driverRegistry.onStatusChange(driver.driverId, (newStatus) => {
      if (newStatus === DriverStatus.BUSY) {
        // 事前受託中のドライバーは自由に流し営業してよい契約のため、
        // 他の客を乗せて実車化すること自体は正常なイベントとして扱う
        this.handleDriverWentBusy(session, driver.driverId);
      }
    });
    return { driver, unsubscribe };
  }

  /** 3分間、優先会社からの受託がゼロ・不足だった場合に募集範囲を全加盟社へ拡張する */
  private expandToAllCompanies(session: DispatchSession): void {
    if (this.isPastOwnNetworkWindow(session.status)) return;
    if (session.primary && session.secondary) return; // 既に2台確保済みなら拡張不要

    session.status = SessionStatus.PENDING_EXPANDED;
    session.offerHandle?.cancel();

    this.logger.info('優先会社からの受託不足のため全加盟社へ募集範囲を拡張', {
      sessionId: session.sessionId,
    });

    this.rebroadcastToFillRemainingSlots(session);
  }

  /**
   * 本命・控えの空き枠を、現在のフェーズ（優先会社限定 or 全社拡張済み）に応じた
   * 候補プールから再募集する。ロック判定の残り時間が尽きていれば何もしない。
   */
  private rebroadcastToFillRemainingSlots(session: DispatchSession): void {
    if (session.primary && session.secondary) return;

    const remainingMs = session.lockCheckpointAt - Date.now();
    if (remainingMs <= 0) return; // ロック判定間近なら再募集しても間に合わないため打ち切る

    const isExpanded = session.status === SessionStatus.PENDING_EXPANDED;
    const candidates = isExpanded
      ? this.driverRegistry.findAvailableDriversInArea(session.input.destination.areaName, session.notifiedDriverIds)
      : this.driverRegistry
          .findAvailableDriversByCompany(session.input.preferredCompanyId)
          .filter((d) => !session.notifiedDriverIds.has(d.driverId));

    if (candidates.length === 0) return;
    candidates.forEach((d) => session.notifiedDriverIds.add(d.driverId));

    session.offerHandle = this.notificationGateway.broadcastOffer(
      candidates.map((d) => d.driverId),
      { sessionId: session.sessionId, destinationAreaName: session.input.destination.areaName },
      remainingMs,
      (driver) => this.handleAcceptance(session, driver)
    );
  }

  /**
   * 本命または控えが移動中に他の客を乗せて実車化（AVAILABLE→BUSY）した瞬間の処理。
   * 事前受託期間中の自由営業を許可している以上、本命の実車化はペナルティ対象外であり、
   * 機会を逃さないよう控えを即座に本命へ自動昇格させる。
   */
  private handleDriverWentBusy(session: DispatchSession, driverId: string): void {
    if (this.isPastOwnNetworkWindow(session.status)) return;

    if (session.primary?.driver.driverId === driverId) {
      // 本命が実車化 -> ペナルティなしで自動リリースし、控えを新しい本命へ即座に昇格させる
      session.primary.unsubscribe();
      session.primary = session.secondary;
      session.secondary = null;

      if (session.primary) {
        this.logger.info('本命が実車化したため控えを本命へ自動昇格', {
          sessionId: session.sessionId,
          newPrimaryDriverId: session.primary.driver.driverId,
        });
      } else {
        this.logger.warn('本命が実車化し控えも不在のため自社マッチングが空席化', {
          sessionId: session.sessionId,
        });
      }
    } else if (session.secondary?.driver.driverId === driverId) {
      // 控えの実車化は本命に影響しないため、控え枠を空けるだけでよい
      session.secondary.unsubscribe();
      session.secondary = null;
      this.logger.info('控えが実車化したため控え枠が空席化', { sessionId: session.sessionId });
    } else {
      return; // 既に解放済みのドライバーからの遅延イベントは無視する
    }

    // 空いた枠をチャンスロスにしないよう、ロック判定までの残り時間内であれば再募集する
    session.offerHandle?.cancel();
    this.rebroadcastToFillRemainingSlots(session);
  }

  // ------------------------------------------------------------
  // ② 10分前自動判定および「確定ロック」
  // ------------------------------------------------------------

  private async runLockCheckpoint(session: DispatchSession): Promise<void> {
    if (this.isPastOwnNetworkWindow(session.status)) return;
    session.offerHandle?.cancel();

    this.logger.info('確定10分前ロック判定を実行', { sessionId: session.sessionId });

    // onStatusChangeの購読は非同期イベント経由のため、ロック直前に必ず「今この瞬間」の
    // 実ステータスを直接再確認する（イベント取りこぼしに対する二重の安全策）
    if (session.primary && this.driverRegistry.getStatus(session.primary.driver.driverId) === DriverStatus.AVAILABLE) {
      this.confirmOwnNetwork(session, session.primary.driver);
      return;
    }

    // 本命が全滅していても、控えが生きていれば控えを本命へ格上げして確定させる
    if (
      session.secondary &&
      this.driverRegistry.getStatus(session.secondary.driver.driverId) === DriverStatus.AVAILABLE
    ) {
      this.confirmOwnNetwork(session, session.secondary.driver);
      return;
    }

    // 本命・控えが共にBUSY（全滅）、または最初から自社マッチングがゼロだった場合、
    // 自社網では確定させられないため即座に他社API委託モードへ移行する
    this.logger.warn('自社マッチングが全滅のため他社API委託モードへ移行', { sessionId: session.sessionId });
    await this.delegateToOtherCompany(session);
  }

  /** 本命（または昇格した控え）を確定ロックし、チケット発券・請求記録まで完了させる */
  private confirmOwnNetwork(session: DispatchSession, driver: Driver): void {
    // 残り10分あれば、地方エリアの流し営業中でも「行き損」にならず薬局へ安全に滑り込める
    this.driverRegistry.lockDriver(driver.driverId);
    session.status = SessionStatus.LOCKED_OWN_NETWORK;
    this.cleanupSession(session);

    const fare = calculateEstimatedFare(session.input.pharmacyLocation, session.input.destination.point);
    const ticket: RideTicket = {
      sessionId: session.sessionId,
      taxiCompanyName: driver.companyName,
      carColor: driver.carColor,
      licensePlate: driver.licensePlateLast4,
      driverName: driver.driverName,
      fare,
      issuedAt: new Date(),
    };

    const billing: BillingRecord = {
      sessionId: session.sessionId,
      billingType: BillingType.OWN_COMMISSION,
      amountYen: this.calculateOwnCommission(fare.estimatedFareYen),
      billedPartyId: driver.companyId,
      createdAt: new Date(),
    };
    this.billingLedger.record(billing);

    session.status = SessionStatus.COMPLETED;
    this.logger.info('自社網で確定ロック完了、チケット発券', { sessionId: session.sessionId, driverId: driver.driverId });
    session.onResult?.({ sessionId: session.sessionId, ticket, billing });
  }

  /** 予測運賃に応じた自社加盟タクシーへの変動手数料（下限あり） */
  private calculateOwnCommission(estimatedFareYen: number): number {
    return Math.max(Math.round(estimatedFareYen * OWN_COMMISSION_RATE), OWN_COMMISSION_MIN_YEN);
  }

  // ------------------------------------------------------------
  // ③ 他社API逆算型・時差発注アルゴリズム
  // ------------------------------------------------------------

  private async delegateToOtherCompany(session: DispatchSession): Promise<void> {
    session.status = SessionStatus.DELEGATED_HOLDING;

    let etaMinutes: number;
    try {
      etaMinutes = await this.otherCompanyApi.getEstimatedArrivalMinutes(session.input.pharmacyLocation);
    } catch (err) {
      // 他社APIとの疎通自体に失敗した場合も、外部へ例外を漏らさず静かに不成立扱いにする
      this.logger.error('他社APIの到着予測取得に失敗', { sessionId: session.sessionId, err });
      this.markFailed(session);
      return;
    }

    // 時差発注の計算式:
    //   発注延期時間 = T_out(10分固定) - T_go(他社到着予測) + B(2分固定バッファ)
    // Bを必ず加えるのは、タクシーが早着すると3分で待機メーターが回ってしまう現場実態があるため、
    // あえてタクシー到着を遅らせて「高齢者が先に外で待っている」状態を作るためである。
    const holdMinutes = T_OUT_MINUTES - etaMinutes + BUFFER_MINUTES;
    const holdMs = Math.max(holdMinutes, 0) * 60_000;

    this.logger.info('時差発注の保留時間を算出', {
      sessionId: session.sessionId,
      etaMinutes,
      holdMinutes,
    });

    const dispatchNow = (): void => {
      void this.executeOtherCompanyDispatch(session);
    };

    if (holdMs <= 0) {
      // 到着予測が長く、保留する余地がない（間に合わせるには即発注するしかない）場合はそのまま発注する
      dispatchNow();
    } else {
      // 発注をあえて保留し、確定 (T_out - holdMinutes) 分前になった瞬間に他社APIへリクエストを投げる
      session.holdTimer = this.scheduler.setTimer(dispatchNow, holdMs);
    }
  }

  private async executeOtherCompanyDispatch(session: DispatchSession): Promise<void> {
    if (session.status === SessionStatus.FAILED || session.status === SessionStatus.COMPLETED) return;

    let result: OtherCompanyDispatchResult | null;
    try {
      result = await this.otherCompanyApi.requestDispatch(
        session.input.pharmacyLocation,
        session.input.destination.areaName
      );
    } catch (err) {
      this.logger.error('他社APIへの配車リクエストが例外終了', { sessionId: session.sessionId, err });
      result = null;
    }

    if (!result) {
      // 他社側でも配車不成立。薬局・患者に無駄な期待をさせないため、通知は一切出さず静かに終了する
      this.markFailed(session);
      return;
    }

    session.status = SessionStatus.CONFIRMED_OTHER_API;
    this.cleanupSession(session);

    const fare = calculateEstimatedFare(session.input.pharmacyLocation, session.input.destination.point);
    const ticket: RideTicket = {
      sessionId: session.sessionId,
      taxiCompanyName: this.otherCompanyApi.providerName,
      carColor: result.carColor,
      licensePlate: result.licensePlateLast4,
      driverName: result.driverName, // 他社APIではドライバー名が取得できないことがあるため任意項目
      fare,
      issuedAt: new Date(),
    };

    const billing: BillingRecord = {
      sessionId: session.sessionId,
      billingType: BillingType.DATA_LEAD_FEE,
      amountYen: DATA_LEAD_FEE_YEN,
      billedPartyId: this.otherCompanyApi.providerName,
      createdAt: new Date(),
    };
    this.billingLedger.record(billing);

    session.status = SessionStatus.COMPLETED;
    this.logger.info('他社API経由で確定完了、チケット発券', { sessionId: session.sessionId });
    session.onResult?.({ sessionId: session.sessionId, ticket, billing });
  }

  // ------------------------------------------------------------
  // 例外処理（手配不成立）
  // ------------------------------------------------------------

  private markFailed(session: DispatchSession): void {
    session.status = SessionStatus.FAILED;
    this.cleanupSession(session);
    this.logger.warn('手配不成立。薬局・患者への通知は行わず静かに終了', { sessionId: session.sessionId });
    // onResult はあえて呼び出さない。呼び出すと薬局端末側に何らかのUI変化が発生し、
    // 「呼んだのに来ない」という無駄な期待・混乱を高齢客に与えてしまうため。
  }

  // ------------------------------------------------------------
  // 共通ユーティリティ
  // ------------------------------------------------------------

  /** 自社網でのマッチングウィンドウが既に終了しているか（以後の受託・実車化イベントを無視してよいか） */
  private isPastOwnNetworkWindow(status: SessionStatus): boolean {
    return (
      status === SessionStatus.LOCKED_OWN_NETWORK ||
      status === SessionStatus.DELEGATED_HOLDING ||
      status === SessionStatus.CONFIRMED_OTHER_API ||
      status === SessionStatus.COMPLETED ||
      status === SessionStatus.FAILED
    );
  }

  /** タイマー・購読を全て解除し、セッションのリソースを解放する */
  private cleanupSession(session: DispatchSession): void {
    session.offerHandle?.cancel();
    session.primary?.unsubscribe();
    session.secondary?.unsubscribe();
    if (session.fallbackTimer) this.scheduler.clearTimer(session.fallbackTimer);
    if (session.lockCheckTimer) this.scheduler.clearTimer(session.lockCheckTimer);
    if (session.holdTimer) this.scheduler.clearTimer(session.holdTimer);
  }
}
