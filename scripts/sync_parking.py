"""Fetch the nationwide parking standard dataset into a public JSON snapshot."""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode
from urllib.request import Request, urlopen


ENDPOINT = "https://api.data.go.kr/openapi/tn_pubr_prkplce_info_api"
SOURCE_URL = "https://www.data.go.kr/data/15012896/standard.do"
ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "parking_lots.json"
PAGE_SIZE = 1000
MAX_PAGES = 100


def first(mapping: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value is not None and str(value).strip() != "":
            return value
    return None


def parse_response(payload: dict[str, Any]) -> tuple[list[dict[str, Any]], int]:
    root = payload.get("response", payload)
    if not isinstance(root, dict):
        raise ValueError("API 응답의 response 항목이 올바른 객체가 아닙니다.")
    body = root.get("body", root)
    if not isinstance(body, dict):
        raise ValueError("API 응답의 body 항목이 올바른 객체가 아닙니다.")

    header = root.get("header", {})
    if isinstance(header, dict):
        code = str(header.get("resultCode", "00"))
        message = str(header.get("resultMsg", ""))
        if code not in {"00", "0", "NORMAL_SERVICE", ""}:
            raise ValueError(f"공공데이터 API 오류 {code}: {message}")

    items = body.get("items", [])
    if isinstance(items, dict):
        # Some gateway responses wrap the array in an `item` property.
        items = items.get("item", [])
    if isinstance(items, dict):
        items = [items]
    if not isinstance(items, list):
        raise ValueError("API 응답의 items 항목이 배열이 아닙니다.")
    total = int(body.get("totalCount", body.get("total_count", len(items))) or 0)
    return [item for item in items if isinstance(item, dict)], total


def fetch_page(api_key: str, page: int) -> tuple[list[dict[str, Any]], int]:
    params = urlencode({
        "serviceKey": unquote(api_key),
        "pageNo": page,
        "numOfRows": PAGE_SIZE,
        "type": "json",
    })
    request = Request(f"{ENDPOINT}?{params}", headers={"User-Agent": "dense-life-parking-tool/1.0"})
    for attempt in range(4):
        try:
            with urlopen(request, timeout=45) as response:
                payload = json.loads(response.read().decode("utf-8-sig"))
            if not isinstance(payload, dict):
                raise ValueError("API 응답이 JSON 객체가 아닙니다.")
            return parse_response(payload)
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as error:
            if attempt == 3:
                raise RuntimeError(f"{page}페이지 요청 실패: {error}") from error
            time.sleep(2 ** attempt)
    raise RuntimeError(f"{page}페이지를 가져오지 못했습니다.")


def as_float(value: Any) -> float | None:
    try:
        result = float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return None
    return result if result == result and abs(result) != float("inf") else None


def normalize(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(first(item, "prkplceNo") or "").strip(),
        "name": str(first(item, "prkplceNm") or "").strip(),
        "category": str(first(item, "prkplceSe") or "").strip(),
        "type": str(first(item, "prkplceType") or "").strip(),
        "address": str(first(item, "rdnmadr", "lnmadr") or "").strip(),
        "lotAddress": str(first(item, "lnmadr") or "").strip(),
        "spaces": as_float(first(item, "prkcmprt")),
        "basicTime": as_float(first(item, "basicTime")),
        "basicCharge": as_float(first(item, "basicCharge")),
        "addUnitTime": as_float(first(item, "addUnitTime")),
        "addUnitCharge": as_float(first(item, "addUnitCharge")),
        "dailyTime": as_float(first(item, "dayCmmtktAdjTime")),
        "dailyCharge": as_float(first(item, "dayCmmtkt")),
        "monthlyCharge": as_float(first(item, "monthCmmtkt")),
        "feeInfo": str(first(item, "parkingchrgeInfo") or "").strip(),
        "note": str(first(item, "spcmnt") or "").strip(),
        "days": str(first(item, "operDay") or "").strip(),
        "weekdayOpen": str(first(item, "weekdayOperOpenHhmm") or "").strip(),
        "weekdayClose": str(first(item, "weekdayOperColseHhmm", "weekdayOperCloseHhmm") or "").strip(),
        "saturdayOpen": str(first(item, "satOperOperOpenHhmm") or "").strip(),
        "saturdayClose": str(first(item, "satOperCloseHhmm") or "").strip(),
        "holidayOpen": str(first(item, "holidayOperOpenHhmm") or "").strip(),
        "holidayClose": str(first(item, "holidayCloseOpenHhmm") or "").strip(),
        "payment": str(first(item, "metpay") or "").strip(),
        "phone": str(first(item, "phoneNumber") or "").strip(),
        "manager": str(first(item, "institutionNm") or "").strip(),
        "latitude": as_float(first(item, "latitude")),
        "longitude": as_float(first(item, "longitude")),
        "referenceDate": str(first(item, "referenceDate") or "").strip(),
    }


def main() -> int:
    api_key = os.environ.get("DATA_GO_KR_API_KEY", "").strip()
    if not api_key:
        print("ERROR: DATA_GO_KR_API_KEY GitHub Actions secret이 설정되지 않았습니다.", file=sys.stderr)
        return 2

    all_items: list[dict[str, Any]] = []
    expected_total: int | None = None
    for page in range(1, MAX_PAGES + 1):
        items, total = fetch_page(api_key, page)
        if expected_total is None:
            expected_total = total
            if expected_total > PAGE_SIZE * MAX_PAGES:
                raise RuntimeError(f"전체 건수 {expected_total}가 안전 상한을 넘습니다. MAX_PAGES를 검토하세요.")
        if not items:
            break
        all_items.extend(items)
        print(f"수집 진행: {len(all_items):,}/{expected_total:,}건 · {page}페이지")
        if len(all_items) >= expected_total:
            break
        time.sleep(0.2)

    normalized = [normalize(item) for item in all_items]
    deduped: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(normalized):
        fallback_id = f"{item['name']}|{item['address']}|{index}"
        key = item["id"] or fallback_id
        deduped[key] = item

    items = list(deduped.values())
    dates = [item["referenceDate"] for item in items if item["referenceDate"]]
    payload = {
        "meta": {
            "fetchedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "recordCount": len(items),
            "apiTotalCount": expected_total or len(items),
            "maxReferenceDate": max(dates) if dates else None,
            "source": SOURCE_URL,
            "note": "지자체 등록 자료입니다. 실시간 잔여 주차면 정보가 아닙니다.",
        },
        "items": items,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"완료: {len(items):,}건 저장 → {OUTPUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
