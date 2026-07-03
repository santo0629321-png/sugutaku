/**
 * 動作確認用デモスクリプト。
 * FastForwardScheduler で「分」を短い実時間に圧縮し、
 * 3つの代表シナリオ（自社確定 / 本命離脱からの自動昇格 / 他社委託）を
 * 数秒で最後まで走らせて挙動を確認する。
 *
 * 実行: npx ts-node src/demo.ts
 */
import {
  Driver,
  DriverStatus,
  DispatchResult,
  INotificationGateway,
  PreDispatchRequestInput,
} from './types';
import { SuguTakuMatchingEngine } from './SuguTakuMatchingEngine';
import {
  ConsoleLogger,
  FastForwardScheduler,
  InMemoryBillingLedger,
  MockDriverRegistry,
  MockGoTaxiAPI,
} from './mocks';

// 1分(60,000ms) を 100ms に圧縮する（30分のフローが約3秒で完了する）
const SPEED_FACTOR = 600;
const scaledMs = (realMs: number): number => realMs / SPEED_FACTOR;

/** デモ検証用：受託タイミングを完全に固定できる決定的な通知ゲートウェイ */
class ScriptedNotificationGateway implements INotificationGateway {
  constructor(
    private readonly registry: MockDriverRegistry,
    // driverId -> 受託までの遅延(圧縮後の実ms)。含まれないドライバーは受託しない
    private readonly acceptScriptMs: Map<string, number>
  ) {}

  broadcastOffer(
    driverIds: string[],
    _context: { sessionId: string; destinationAreaName: string },
    _durationMs: number,
    onAccept: (driver: Driver) => void
  ): { cancel: () => void } {
    let cancelled = false;
    const timers: NodeJS.Timeout[] = [];

    driverIds.forEach((driverId) => {
      const delay = this.acceptScriptMs.get(driverId);
      if (delay === undefined) return; // このドライバーは今回受託しない想定
      const timer = setTimeout(() => {
        if (cancelled) return;
        if (this.registry.getStatus(driverId) !== DriverStatus.AVAILABLE) return;
        const driver = this.registry.findAvailableDriversInArea('', new Set()).find((d) => d.driverId === driverId);
        if (driver) onAccept(driver);
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

function baseInput(overrides: Partial<PreDispatchRequestInput> = {}): PreDispatchRequestInput {
  return {
    seniorMemberId: 'senior-0001',
    preferredCompanyId: 'company-ganso',
    destination: {
      areaName: '福岡市西区元岡',
      point: { lat: 33.5959, lng: 130.2183 },
    },
    pharmacyId: 'pharmacy-001',
    pharmacyLocation: { lat: 33.5845, lng: 130.3466 },
    minutesUntilCheckout: 30,
    ...overrides,
  };
}

function printResult(label: string, result: DispatchResult | null): void {
  if (!result) {
    console.log(`\n=== ${label}: 結果 ===> 手配不成立(FAILED) / 通知なし\n`);
    return;
  }
  console.log(`\n=== ${label}: 乗車チケット ===`);
  console.log(`  会社名        : ${result.ticket.taxiCompanyName}`);
  console.log(`  車体カラー    : ${result.ticket.carColor}`);
  console.log(`  ナンバー下4桁 : ${result.ticket.licensePlate}`);
  console.log(`  ドライバー名  : ${result.ticket.driverName ?? '(他社委託のため省略)'}`);
  console.log(`  予測距離/運賃 : ${result.ticket.fare.distanceKm}km / ${result.ticket.fare.estimatedFareYen}円`);
  console.log(`  請求種別      : ${result.billing.billingType} (${result.billing.amountYen}円 -> ${result.billing.billedPartyId})`);
  console.log('');
}

// ------------------------------------------------------------
// シナリオA: 優先会社の本命がそのまま空車を維持 -> T-10分でロック確定
// ------------------------------------------------------------
function scenarioA(): void {
  const registry = new MockDriverRegistry();
  registry.addDriver({
    driverId: 'driver-A1',
    driverName: '鈴木さん',
    companyId: 'company-ganso',
    companyName: '元祖交通',
    carColor: '黄色',
    licensePlateLast4: '555',
    status: DriverStatus.AVAILABLE,
  });

  const gateway = new ScriptedNotificationGateway(registry, new Map([['driver-A1', scaledMs(5_000)]]));
  const engine = new SuguTakuMatchingEngine(
    registry,
    gateway,
    new MockGoTaxiAPI(7),
    new InMemoryBillingLedger(),
    new FastForwardScheduler(SPEED_FACTOR),
    new ConsoleLogger()
  );

  engine.submitPreDispatchRequest(baseInput(), (result) => printResult('シナリオA(自社確定)', result));
}

// ------------------------------------------------------------
// シナリオB: 本命が移動中に実車化 -> 控えが自動昇格 -> 昇格後は空車のままロック確定
// ------------------------------------------------------------
function scenarioB(): void {
  const registry = new MockDriverRegistry();
  registry.addDriver({
    driverId: 'driver-B1',
    driverName: '田中さん',
    companyId: 'company-ganso',
    companyName: '元祖交通',
    carColor: '緑',
    licensePlateLast4: '123',
    status: DriverStatus.AVAILABLE,
  });
  registry.addDriver({
    driverId: 'driver-B2',
    driverName: '佐藤さん',
    companyId: 'company-ganso',
    companyName: '元祖交通',
    carColor: '黄色',
    licensePlateLast4: '456',
    status: DriverStatus.AVAILABLE,
  });

  // B1が先に本命として受託、少し遅れてB2が控えとして受託する
  const gateway = new ScriptedNotificationGateway(
    registry,
    new Map([
      ['driver-B1', scaledMs(1_000)],
      ['driver-B2', scaledMs(2_000)],
    ])
  );
  const engine = new SuguTakuMatchingEngine(
    registry,
    gateway,
    new MockGoTaxiAPI(7),
    new InMemoryBillingLedger(),
    new FastForwardScheduler(SPEED_FACTOR),
    new ConsoleLogger()
  );

  engine.submitPreDispatchRequest(baseInput(), (result) => printResult('シナリオB(本命離脱->控え昇格)', result));

  // 本命(B1)が別客を拾って実車化した瞬間を模擬する（受託確定から少し後）
  setTimeout(() => {
    console.log('[DEMO] 本命(driver-B1)が別客を乗せて実車化(BUSY)します');
    registry.setStatus('driver-B1', DriverStatus.BUSY);
  }, scaledMs(4_000));
}

// ------------------------------------------------------------
// シナリオC: 自社が全滅 -> 他社API(GO)へ時差発注で委託確定
// ------------------------------------------------------------
function scenarioC(): void {
  const registry = new MockDriverRegistry();
  registry.addDriver({
    driverId: 'driver-C1',
    driverName: '本命(全滅予定)',
    companyId: 'company-ganso',
    companyName: '元祖交通',
    carColor: '白',
    licensePlateLast4: '999',
    status: DriverStatus.AVAILABLE,
  });

  const gateway = new ScriptedNotificationGateway(registry, new Map([['driver-C1', scaledMs(1_000)]]));
  // GOの到着予測が7分 -> 発注延期時間 = 10 - 7 + 2 = 5分 保留してから発注される想定
  const engine = new SuguTakuMatchingEngine(
    registry,
    gateway,
    new MockGoTaxiAPI(7),
    new InMemoryBillingLedger(),
    new FastForwardScheduler(SPEED_FACTOR),
    new ConsoleLogger()
  );

  engine.submitPreDispatchRequest(baseInput(), (result) => printResult('シナリオC(他社API時差発注)', result));

  // 唯一の候補(C1)も、ロック判定(T-10分 = 開始20分後)より前に実車化させ、自社を完全に全滅させる
  setTimeout(() => {
    console.log('[DEMO] 唯一の候補(driver-C1)も実車化(BUSY)し、自社が全滅します');
    registry.setStatus('driver-C1', DriverStatus.BUSY);
  }, scaledMs(15 * 60_000)); // 開始15分後(ロック判定の5分前)に全滅させる
}

async function main(): Promise<void> {
  scenarioA();
  await sleep(scaledMs(21_000));
  scenarioB();
  await sleep(scaledMs(21_000));
  scenarioC();
  await sleep(scaledMs(31 * 60_000));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main();
