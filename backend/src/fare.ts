/**
 * 運賃・距離予測ロジック
 *
 * 実運用では地図会社のルート探索APIに差し替える想定だが、
 * ここでは「薬局の位置」と「匿名化済み行先エリアの代表座標」のみから
 * 直線距離ベースで概算する（住所は保持していないため、これ以上の精度は出せない）。
 */
import { FareEstimate, MaskedGeoPoint } from './types';

const EARTH_RADIUS_KM = 6371;

/** 2点間の直線距離（km）をハーバサイン公式で算出する */
function haversineDistanceKm(a: MaskedGeoPoint, b: MaskedGeoPoint): number {
  const toRad = (deg: number): number => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

// 地方都市の一般的なタクシー運賃体系を模した簡易モデル
// （初乗り1.2km 500円、以後280mごとに90円加算という地方都市の実勢に近い設定）
const BASE_FARE_YEN = 500;
const BASE_DISTANCE_KM = 1.2;
const METER_STEP_KM = 0.28;
const METER_STEP_FARE_YEN = 90;

// 直線距離は実際の道路距離より短くなるため、実勢に合わせて係数をかけて補正する
// （地方都市は幹線道路が少なく迂回が発生しやすいため、都市部より高めの係数にしている）
const ROAD_DISTANCE_FACTOR = 1.3;

/**
 * 薬局の位置から匿名化済み行先エリアまでの推定走行距離・予測運賃を計算する。
 * 患者の正確な住所は保持していないため、あくまで「町丁目代表点」までの概算値である。
 */
export function calculateEstimatedFare(
  pharmacyLocation: MaskedGeoPoint,
  destinationPoint: MaskedGeoPoint
): FareEstimate {
  const straightDistanceKm = haversineDistanceKm(pharmacyLocation, destinationPoint);
  const distanceKm = straightDistanceKm * ROAD_DISTANCE_FACTOR;

  let fare = BASE_FARE_YEN;
  const remainingKm = distanceKm - BASE_DISTANCE_KM;
  if (remainingKm > 0) {
    const steps = Math.ceil(remainingKm / METER_STEP_KM);
    fare += steps * METER_STEP_FARE_YEN;
  }

  return {
    distanceKm: Math.round(distanceKm * 100) / 100,
    estimatedFareYen: fare,
  };
}
