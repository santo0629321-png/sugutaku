/**
 * 参照実装・デモ用のモック群。
 * 本番では IDriverRegistry は自社配車基盤、ITaxiCompanyAPI はGO等のSDK、
 * INotificationGateway はプッシュ通知基盤（FCM等）に差し替える。
 */
import {
  Driver,
  DriverStatus,
  IBillingLedger,
  IDriverRegistry,
  ILogger,
  INotificationGateway,
  IScheduler,
  ITaxiCompanyAPI,
  MaskedGeoPoint,
  OtherCompanyDispatchResult,
  BillingRecord,
} from './types';

// ------------------------------------------------------------
// スケジューラ
// ------------------------------------------------------------

/** 本番用: Node標準のsetTimeout/clearTimeoutをそのまま使う実装 */
export class RealScheduler implements IScheduler {
  setTimer(fn: () => void, delayMs: number): unknown {
    return setTimeout(fn, delayMs);
  }
  clearTimer(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  }
}

/**
 * デモ・テスト用: 実際の「分」を短い実時間に圧縮して動作確認できるようにするスケジューラ。
 * speedFactor=1200 なら 1分(60,000ms) が 50ms に短縮される。
 */
export class FastForwardScheduler implements IScheduler {
  constructor(private readonly speedFactor: number) {}

  setTimer(fn: () => void, delayMs: number): unknown {
    return setTimeout(fn, delayMs / this.speedFactor);
  }
  clearTimer(handle: unknown): void {
    clearTimeout(handle as NodeJS.Timeout);
  }
}

// ------------------------------------------------------------
// ロガー・請求台帳
// ------------------------------------------------------------

export class ConsoleLogger implements ILogger {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(`[INFO] ${message}`, meta ?? '');
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(`[WARN] ${message}`, meta ?? '');
  }
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`[ERROR] ${message}`, meta ?? '');
  }
}

export class InMemoryBillingLedger implements IBillingLedger {
  readonly records: BillingRecord[] = [];
  record(entry: BillingRecord): void {
    this.records.push(entry);
  }
}

// ------------------------------------------------------------
// ドライバーレジストリ（自社配車基盤のモック）
// ------------------------------------------------------------

interface DriverRecord {
  driver: Driver;
  listeners: Set<(status: DriverStatus) => void>;
}

export class MockDriverRegistry implements IDriverRegistry {
  private readonly drivers = new Map<string, DriverRecord>();

  addDriver(driver: Driver): void {
    this.drivers.set(driver.driverId, { driver: { ...driver }, listeners: new Set() });
  }

  findAvailableDriversByCompany(companyId: string): Driver[] {
    return [...this.drivers.values()]
      .map((r) => r.driver)
      .filter((d) => d.companyId === companyId && d.status === DriverStatus.AVAILABLE);
  }

  findAvailableDriversInArea(_areaName: string, excludeDriverIds: ReadonlySet<string>): Driver[] {
    // モックでは全ドライバーをエリア内とみなす（本番では位置情報からエリア判定する）
    return [...this.drivers.values()]
      .map((r) => r.driver)
      .filter((d) => d.status === DriverStatus.AVAILABLE && !excludeDriverIds.has(d.driverId));
  }

  getStatus(driverId: string): DriverStatus {
    const record = this.drivers.get(driverId);
    if (!record) throw new Error(`未登録のドライバーIDです: ${driverId}`);
    return record.driver.status;
  }

  onStatusChange(driverId: string, callback: (newStatus: DriverStatus) => void): () => void {
    const record = this.drivers.get(driverId);
    if (!record) throw new Error(`未登録のドライバーIDです: ${driverId}`);
    record.listeners.add(callback);
    return () => record.listeners.delete(callback);
  }

  lockDriver(driverId: string): void {
    this.setStatus(driverId, DriverStatus.LOCKED);
  }

  /** デモ・テストからドライバーの実車化などを模擬的に発生させるための操作用API */
  setStatus(driverId: string, status: DriverStatus): void {
    const record = this.drivers.get(driverId);
    if (!record) throw new Error(`未登録のドライバーIDです: ${driverId}`);
    record.driver.status = status;
    record.listeners.forEach((cb) => cb(status));
  }
}

// ------------------------------------------------------------
// 通知ゲートウェイ（プッシュ通知基盤のモック）
// ------------------------------------------------------------

/**
 * ドライバーが乱数時間で受託するさまを模擬する通知ゲートウェイ。
 * acceptProbabilityPerDriver: 各ドライバーが受託する確率（0〜1）
 */
export class MockNotificationGateway implements INotificationGateway {
  constructor(
    private readonly registry: MockDriverRegistry,
    private readonly acceptProbabilityPerDriver = 0.6,
    private readonly maxAcceptDelayMs = 5_000
  ) {}

  broadcastOffer(
    driverIds: string[],
    _context: { sessionId: string; destinationAreaName: string },
    durationMs: number,
    onAccept: (driver: Driver) => void
  ): { cancel: () => void } {
    let cancelled = false;
    const timers: NodeJS.Timeout[] = [];

    driverIds.forEach((driverId) => {
      if (Math.random() > this.acceptProbabilityPerDriver) return; // 受託しないドライバーもいる
      const delay = Math.random() * Math.min(this.maxAcceptDelayMs, durationMs);
      const timer = setTimeout(() => {
        if (cancelled) return;
        if (this.registry.getStatus(driverId) !== DriverStatus.AVAILABLE) return;
        onAccept(this.registry.findAvailableDriversInArea('', new Set()).find((d) => d.driverId === driverId)!);
      }, delay);
      timers.push(timer);
    });

    return {
      cancel: () => {
        cancelled = true;
        timers.forEach((t) => clearTimeout(t));
      },
    };
  }
}

// ------------------------------------------------------------
// 他社タクシーAPI（GO等）のモック
// ------------------------------------------------------------

export class MockGoTaxiAPI implements ITaxiCompanyAPI {
  readonly providerName = 'GO';

  constructor(
    private readonly simulatedEtaMinutes = 7,
    private readonly failureRate = 0
  ) {}

  async getEstimatedArrivalMinutes(_pickup: MaskedGeoPoint): Promise<number> {
    return this.simulatedEtaMinutes;
  }

  async requestDispatch(
    _pickup: MaskedGeoPoint,
    _destinationAreaName: string
  ): Promise<OtherCompanyDispatchResult | null> {
    if (Math.random() < this.failureRate) return null;
    return {
      carColor: '白',
      licensePlateLast4: '8823',
      estimatedArrivalMinutes: this.simulatedEtaMinutes,
    };
  }
}
