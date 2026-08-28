import { useEffect, useState, useMemo, useRef, useCallback } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceArea,
} from "recharts";
import "./App.css";
import { supabase } from "./supabase";

const API_URL = "https://api.frankfurter.dev/v2/rate/USD/KRW";
const SOURCE_URL = "https://api.frankfurter.dev/v2/rate/USD/KRW";

const ERROR_MODES = {
  timeout: "timeout",
  auth: "auth",
  limit: "limit",
  offline: "offline",
  format: "format",
};

function getKoreaDate() {
  return new Date().toLocaleDateString("sv-SE", {
    timeZone: "Asia/Seoul",
  });
}

function getKoreaDateTime() {
  return new Date().toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
  });
}

// Custom Tooltip 컴포넌트
const CustomTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    return (
      <div className="custom-tooltip">
        <p className="tooltip-date">{label}</p>
        <p className="tooltip-rate">
          환율: <strong>{Number(payload[0].value).toLocaleString()} KRW</strong>
        </p>
      </div>
    );
  }
  return null;
};

function App() {
  const [rate, setRate] = useState(null);
  const [apiDate, setApiDate] = useState(null);
  const [status, setStatus] = useState("조회 중");
  const [statusType, setStatusType] = useState("loading");
  const [lastChecked, setLastChecked] = useState(null);

  const [records, setRecords] = useState([]);
  const [verificationOpen, setVerificationOpen] = useState(false);

  // 새로고침 로딩 상태
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 검증 로그
  const [logs, setLogs] = useState([]);

  // T05-01, T05-02: 기간 선택 상태 ('3d' | '5d' | '1m' | 'all')
  const [period, setPeriod] = useState("5d");

  // -----------------------------
  // T05-06, T05-08, T05-09: 차트 Zoom / Pan 상태
  // -----------------------------
  // 확대된 구간 (chartData 기준 인덱스). null이면 전체 구간 표시.
  const [zoomDomain, setZoomDomain] = useState(null);
  // 드래그로 확대 영역을 선택하는 동안 표시할 임시 영역
  const [refAreaLeft, setRefAreaLeft] = useState("");
  const [refAreaRight, setRefAreaRight] = useState("");
  // 확대된 상태에서 드래그로 이동(Pan) 중인지 여부
  const [isPanning, setIsPanning] = useState(false);
  const panStartIndexRef = useRef(null);

  const ZOOM_MIN_POINTS = 3;

  // -----------------------------
  // 검증 로그 추가
  // -----------------------------
  const addLog = (message, type = "info") => {
    const time = new Date().toLocaleTimeString("ko-KR", {
      timeZone: "Asia/Seoul",
      hour12: false,
    });

    setLogs((prev) => [
      ...prev.slice(-19),
      {
        id: `${Date.now()}-${Math.random()}`,
        time,
        message,
        type,
      },
    ]);
  };

  // -----------------------------
  // Supabase 기록 불러오기
  // -----------------------------
  const loadRecords = async () => {
    const { data, error } = await supabase
      .from("exchange_records")
      .select("*")
      .order("record_date", { ascending: false });

    if (error) {
      console.error("기록 불러오기 실패:", error);
      addLog("Supabase 기록 조회 실패", "error");
      return;
    }

    setRecords(data ?? []);
  };

  // -----------------------------
  // 오늘 기록 자동 저장
  // -----------------------------
  const saveTodayRecord = async (data) => {
    const today = getKoreaDate();
    const fetchedAt = new Date().toISOString();

    addLog(`오늘 기록 확인: ${today}`);

    const newRecord = {
      record_date: today,
      rate: data.rate,
      normalized_value: data.rate,
      unit: "KRW per USD",

      api_date: data.date,
      checked_at: fetchedAt,

      signal_id: "usd-krw",
      source_name: "Frankfurter API",
      source_url: API_URL,
      source_time: data.date ? `${data.date}T00:00:00.000Z` : null,
      fetched_at: fetchedAt,
      record_timezone: "Asia/Seoul",
    };

    const { data: existingRecord, error: checkError } = await supabase
      .from("exchange_records")
      .select("id")
      .eq("record_date", today)
      .maybeSingle();

    if (checkError) {
      console.error("기존 기록 확인 실패:", checkError);
      addLog("기존 날짜 기록 확인 실패", "error");
      return;
    }

    if (existingRecord) {
      addLog("오늘 기록 존재 → 기존 기록 갱신");

      const { error: updateError } = await supabase
        .from("exchange_records")
        .update(newRecord)
        .eq("id", existingRecord.id);

      if (updateError) {
        console.error("오늘 기록 갱신 실패:", updateError);
        addLog("Supabase 기록 갱신 실패", "error");
        return;
      }

      addLog("오늘 데이터 Supabase 갱신 완료", "success");
      await loadRecords();
      return;
    }

    addLog("오늘 실제 환율 데이터 신규 저장 시작");

    const { error: insertError } = await supabase
      .from("exchange_records")
      .insert(newRecord);

    if (insertError) {
      console.error("오늘 기록 저장 실패:", insertError);
      addLog("Supabase 저장 실패", "error");
      return;
    }

    addLog("오늘 데이터 Supabase 신규 저장 완료", "success");
    await loadRecords();
  };

  // -----------------------------
  // 테스트용 오류 발생
  // -----------------------------
  const simulateError = async (mode) => {
    if (mode === ERROR_MODES.timeout) {
      addLog("API 요청 시작");
      addLog("Timeout 테스트: 요청 지연 시작");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      addLog("Timeout 감지", "error");
      throw new Error("TIMEOUT");
    }

    if (mode === ERROR_MODES.auth) {
      addLog("API 요청 시작");
      addLog("테스트 응답: HTTP 401");
      addLog("인증 실패 감지", "error");
      throw new Error("AUTH_FAILED");
    }

    if (mode === ERROR_MODES.limit) {
      addLog("API 요청 시작");
      addLog("테스트 응답: HTTP 429");
      addLog("호출 제한 감지", "error");
      throw new Error("RATE_LIMIT");
    }

    if (mode === ERROR_MODES.offline) {
      addLog("네트워크 요청 시작");
      addLog("Network Error 감지", "error");
      throw new Error("OFFLINE");
    }

    if (mode === ERROR_MODES.format) {
      addLog("API 응답 수신");
      addLog("응답 필드 검사 시작");
      addLog("필수 필드(rate/date) 확인 실패", "error");
      return { wrong: true };
    }

    return null;
  };

  // -----------------------------
  // 실제 환율 조회 (새로고침)
  // -----------------------------
  const fetchRate = async (mode = null) => {
    if (isRefreshing) return;

    try {
      setIsRefreshing(true);
      setStatus("조회 중");
      setStatusType("loading");

      if (mode) {
        addLog(`검증 테스트 시작: ${getModeName(mode)}`);
      } else {
        addLog("실제 API 요청 시작");
      }

      let data;

      if (mode) {
        data = await simulateError(mode);
      } else {
        const response = await fetch(API_URL);
        addLog(`API 응답 수신: HTTP ${response.status}`);

        if (!response.ok) {
          throw new Error(`HTTP_${response.status}`);
        }

        data = await response.json();
        addLog("API JSON 파싱 완료");
      }

      if (
        !data ||
        typeof data.rate !== "number" ||
        typeof data.date !== "string"
      ) {
        throw new Error("FORMAT_CHANGED");
      }

      setRate(data.rate);
      setApiDate(data.date);
      setLastChecked(getKoreaDateTime());

      setStatus("정상");
      setStatusType("normal");

      addLog("정상 데이터 확인", "success");
      addLog("화면값 갱신 완료", "success");

      if (!mode) {
        await saveTodayRecord(data);
      }

      if (mode) {
        addLog(`${getModeName(mode)} 테스트 종료`, "success");
      }
    } catch (error) {
      console.error(error);

      let message = "조회 실패";
      switch (error.message) {
        case "TIMEOUT":
          message = "시간 초과";
          break;
        case "AUTH_FAILED":
          message = "인증 실패";
          break;
        case "RATE_LIMIT":
          message = "호출 제한";
          break;
        case "OFFLINE":
          message = "오프라인";
          break;
        case "FORMAT_CHANGED":
          message = "응답 형식 변경";
          break;
        default:
          message = "조회 실패";
      }

      setStatus(message);
      setStatusType("stale");
      addLog(`${message} 처리 분기로 이동`, "error");

      if (rate !== null) {
        addLog(`마지막 정상값 유지: ${rate.toLocaleString()} KRW`, "success");
        addLog("현재 자료가 아니므로 '오래된 데이터' 표시", "warning");
      } else {
        addLog("정상값이 없어 값을 표시하지 않음", "warning");
      }
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleRefresh = () => {
    fetchRate();
  };

  function getModeName(mode) {
    const names = {
      timeout: "Timeout",
      auth: "인증 실패",
      limit: "호출 제한",
      offline: "오프라인",
      format: "응답 형식 변경",
    };
    return names[mode] ?? mode;
  }

  useEffect(() => {
    const start = async () => {
      await loadRecords();
      await fetchRate();
    };
    start();
  }, []);

  const runErrorTest = (mode) => {
    fetchRate(mode);
  };

  const clearLogs = () => {
    setLogs([]);
  };

  // 3일 / 5일 / 1개월 / 전체 선택 필터링
  const chartData = useMemo(() => {
    if (!records || records.length === 0) return [];

    const sorted = [...records].sort(
      (a, b) => new Date(a.record_date) - new Date(b.record_date)
    );

    if (period === "all") {
      return sorted.map((r) => ({
        date: r.record_date,
        rate: Number(r.normalized_value ?? r.rate),
      }));
    }

    const now = new Date();
    let cutoff = new Date();

    if (period === "3d") {
      cutoff.setDate(now.getDate() - 3);
    } else if (period === "5d") {
      cutoff.setDate(now.getDate() - 5);
    } else if (period === "1m") {
      cutoff.setMonth(now.getMonth() - 1);
    }

    return sorted
      .filter((r) => new Date(r.record_date) >= cutoff)
      .map((r) => ({
        date: r.record_date,
        rate: Number(r.normalized_value ?? r.rate),
      }));
  }, [records, period]);

  // 기간(period)이 바뀌면 확대/이동 상태를 초기화
  useEffect(() => {
    setZoomDomain(null);
    setRefAreaLeft("");
    setRefAreaRight("");
    setIsPanning(false);
    panStartIndexRef.current = null;
  }, [period]);

  // 시작/끝 인덱스가 데이터 범위를 벗어나지 않도록 보정 (구간 크기는 유지)
  const clampWindow = useCallback((startIndex, endIndex, dataLength) => {
    let s = startIndex;
    let e = endIndex;

    if (s < 0) {
      e += -s;
      s = 0;
    }
    if (e > dataLength - 1) {
      s -= e - (dataLength - 1);
      e = dataLength - 1;
    }

    s = Math.max(0, s);
    e = Math.min(dataLength - 1, Math.max(e, s));
    return { startIndex: s, endIndex: e };
  }, []);

  // 실제로 화면에 표시되는 데이터 (확대된 경우 해당 구간만)
  const displayedData = useMemo(() => {
    if (!zoomDomain) return chartData;
    return chartData.slice(zoomDomain.startIndex, zoomDomain.endIndex + 1);
  }, [chartData, zoomDomain]);

  const isZoomed = zoomDomain !== null;

  const zoomToWindow = useCallback(
    (startIndex, endIndex) => {
      if (chartData.length < ZOOM_MIN_POINTS) return;
      const clamped = clampWindow(startIndex, endIndex, chartData.length);
      if (clamped.endIndex - clamped.startIndex + 1 >= chartData.length) {
        setZoomDomain(null);
      } else {
        setZoomDomain(clamped);
      }
    },
    [chartData.length, clampWindow]
  );

  // T05-08: 버튼으로 확대
  const handleZoomIn = () => {
    const total = chartData.length;
    if (total < ZOOM_MIN_POINTS) return;

    const current = zoomDomain ?? { startIndex: 0, endIndex: total - 1 };
    const currentSize = current.endIndex - current.startIndex + 1;
    const newSize = Math.max(ZOOM_MIN_POINTS, Math.round(currentSize * 0.6));
    if (newSize >= currentSize) return;

    const center = (current.startIndex + current.endIndex) / 2;
    const half = (newSize - 1) / 2;
    zoomToWindow(Math.round(center - half), Math.round(center + half));
    addLog("차트 확대(+) 조작", "info");
  };

  // T05-08: 버튼으로 축소
  const handleZoomOut = () => {
    const total = chartData.length;
    const current = zoomDomain ?? { startIndex: 0, endIndex: total - 1 };
    const currentSize = current.endIndex - current.startIndex + 1;
    const newSize = Math.min(total, Math.round(currentSize / 0.6));

    if (newSize >= total) {
      setZoomDomain(null);
    } else {
      const center = (current.startIndex + current.endIndex) / 2;
      const half = (newSize - 1) / 2;
      zoomToWindow(Math.round(center - half), Math.round(center + half));
    }
    addLog("차트 축소(-) 조작", "info");
  };

  // T05-09: 버튼으로 좌우 이동 (Pan)
  const handlePanButton = (direction) => {
    if (!zoomDomain) return;
    const windowSize = zoomDomain.endIndex - zoomDomain.startIndex + 1;
    const step = Math.max(1, Math.round(windowSize * 0.3)) * direction;
    zoomToWindow(zoomDomain.startIndex + step, zoomDomain.endIndex + step);
  };

  // T05-06: 전체 보기로 복귀
  const handleResetZoom = () => {
    setZoomDomain(null);
    addLog("차트 확대/이동 초기화", "info");
  };

  // 마우스 휠로 확대/축소
  const handleWheelZoom = (e) => {
    if (chartData.length < ZOOM_MIN_POINTS) return;
    e.preventDefault();
    if (e.deltaY < 0) {
      handleZoomIn();
    } else if (e.deltaY > 0) {
      handleZoomOut();
    }
  };

  // 마우스 Down: 확대 전이면 드래그 영역 선택 시작, 확대 상태면 Pan 시작
  const handleChartMouseDown = (e) => {
    if (!e) return;
    if (isZoomed) {
      if (e.activeTooltipIndex === undefined || e.activeTooltipIndex === null) return;
      setIsPanning(true);
      panStartIndexRef.current = e.activeTooltipIndex;
    } else {
      if (e.activeLabel === undefined) return;
      setRefAreaLeft(e.activeLabel);
      setRefAreaRight(e.activeLabel);
    }
  };

  // 마우스 Move: 드래그 영역 갱신 또는 Pan 이동 처리
  const handleChartMouseMove = (e) => {
    if (!e) return;

    if (isPanning) {
      if (
        e.activeTooltipIndex === undefined ||
        e.activeTooltipIndex === null ||
        panStartIndexRef.current === null
      ) {
        return;
      }
      const delta = e.activeTooltipIndex - panStartIndexRef.current;
      if (delta === 0) return;

      setZoomDomain((prev) => {
        if (!prev) return prev;
        const windowSize = prev.endIndex - prev.startIndex;
        const next = clampWindow(
          prev.startIndex - delta,
          prev.endIndex - delta,
          chartData.length
        );
        // 경계에 도달해 구간 크기가 줄어들면 더 이상 이동하지 않음
        if (next.endIndex - next.startIndex !== windowSize) return prev;
        return next;
      });
      panStartIndexRef.current = e.activeTooltipIndex;
    } else if (refAreaLeft) {
      if (e.activeLabel === undefined) return;
      setRefAreaRight(e.activeLabel);
    }
  };

  // 마우스 Up: 드래그 영역을 실제 확대 구간으로 확정하거나 Pan 종료
  const handleChartMouseUp = () => {
    if (isPanning) {
      setIsPanning(false);
      panStartIndexRef.current = null;
      return;
    }

    if (refAreaLeft && refAreaRight && refAreaLeft !== refAreaRight) {
      let leftIndex = chartData.findIndex((d) => d.date === refAreaLeft);
      let rightIndex = chartData.findIndex((d) => d.date === refAreaRight);

      if (leftIndex !== -1 && rightIndex !== -1) {
        if (leftIndex > rightIndex) {
          [leftIndex, rightIndex] = [rightIndex, leftIndex];
        }
        if (rightIndex - leftIndex >= 1) {
          zoomToWindow(leftIndex, rightIndex);
          addLog(`차트 드래그 확대: ${refAreaLeft} ~ ${refAreaRight}`, "info");
        }
      }
    }

    setRefAreaLeft("");
    setRefAreaRight("");
  };

  const yDomain = useMemo(() => {
    if (displayedData.length === 0) return [0, "auto"];
    const rates = displayedData.map((d) => d.rate);
    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const padding = Math.max((max - min) * 0.1, 1);
    return [Math.floor(min - padding), Math.ceil(max + padding)];
  }, [displayedData]);

  const currentRecord = records[0];
  const previousRecord = records[1];

  let difference = null;
  let changeRate = null;

  if (currentRecord && previousRecord) {
    const currentValue = Number(
      currentRecord.normalized_value ?? currentRecord.rate
    );
    const previousValue = Number(
      previousRecord.normalized_value ?? previousRecord.rate
    );

    if (
      Number.isFinite(currentValue) &&
      Number.isFinite(previousValue) &&
      previousValue !== 0 &&
      currentRecord.unit === previousRecord.unit
    ) {
      difference = currentValue - previousValue;
      changeRate = (difference / previousValue) * 100;
    }
  }

  return (
    <div className="app">
      <div className="container">
        <header className="header">
          <div>
            <p className="eyebrow">DAILY INFORMATION BOARD</p>
            <h1>오늘의 환율 정보판</h1>
            <p className="description">
              USD / KRW 환율을 확인하고 날짜별 변화를 기록합니다.
            </p>
          </div>

          <div className="header-actions">
            <button
              className="refresh-button"
              onClick={handleRefresh}
              disabled={isRefreshing}
            >
              {isRefreshing ? "로딩 중..." : "🔄 새로고침"}
            </button>
          </div>
        </header>

        <main className="dashboard">
          {/* 현재 환율 */}
          <section className="card main-card">
            <div className="card-top">
              <div>
                <span className="label">현재 환율</span>
                <h2>USD / KRW</h2>
              </div>

              <span className={`status ${statusType}`}>
                {statusType === "stale" ? `${status} · 오래된 데이터` : status}
              </span>
            </div>

            <div className="main-rate">
              {rate !== null ? rate.toLocaleString() : "-"}
              <span>KRW</span>
            </div>

            <div className="info-grid">
              <div className="info-item">
                <span>단위</span>
                <strong>KRW per USD</strong>
              </div>
              <div className="info-item">
                <span>API 기준 날짜</span>
                <strong>{apiDate ?? "-"}</strong>
              </div>
              <div className="info-item">
                <span>기준 시간대</span>
                <strong>Asia/Seoul</strong>
              </div>
              <div className="info-item">
                <span>마지막 정상 조회</span>
                <strong>{lastChecked ?? "-"}</strong>
              </div>
            </div>
          </section>

          {/* 출처 */}
          <section className="card">
            <div className="section-title">
              <div>
                <span className="label">SOURCE</span>
                <h2>데이터 출처</h2>
              </div>
            </div>

            <div className="source-box">
              <div>
                <strong>Frankfurter API</strong>
                <p>USD / KRW 환율 원자료</p>
              </div>

              <a
                href={SOURCE_URL}
                target="_blank"
                rel="noreferrer"
                className="source-button"
              >
                원자료 열기 →
              </a>
            </div>
          </section>

          {/* 환율 추이 그래프 섹션 */}
          <section className="card chart-card">
            <div className="section-title">
              <div>
                <span className="label">TREND CHART</span>
                <h2>환율 추이 그래프</h2>
              </div>

              {/* 3일, 5일, 1개월, 전체 옵션 적용 */}
              <div className="period-buttons">
                <button
                  className={period === "3d" ? "active" : ""}
                  onClick={() => setPeriod("3d")}
                >
                  3일
                </button>
                <button
                  className={period === "5d" ? "active" : ""}
                  onClick={() => setPeriod("5d")}
                >
                  5일
                </button>
                <button
                  className={period === "1m" ? "active" : ""}
                  onClick={() => setPeriod("1m")}
                >
                  1개월
                </button>
                <button
                  className={period === "all" ? "active" : ""}
                  onClick={() => setPeriod("all")}
                >
                  전체
                </button>
              </div>
            </div>

            {/* T05-06, T05-08, T05-09: 차트 조작(확대/축소/이동) 컨트롤 */}
            <div className="chart-zoom-controls">
              <div className="zoom-button-group">
                <button
                  type="button"
                  onClick={() => handlePanButton(-1)}
                  disabled={!isZoomed}
                  aria-label="이전 구간으로 이동"
                >
                  ◀
                </button>
                <button
                  type="button"
                  onClick={handleZoomOut}
                  disabled={!isZoomed}
                  aria-label="축소"
                >
                  －
                </button>
                <button
                  type="button"
                  onClick={handleZoomIn}
                  disabled={chartData.length < ZOOM_MIN_POINTS}
                  aria-label="확대"
                >
                  ＋
                </button>
                <button
                  type="button"
                  onClick={() => handlePanButton(1)}
                  disabled={!isZoomed}
                  aria-label="다음 구간으로 이동"
                >
                  ▶
                </button>
                <button
                  type="button"
                  className="zoom-reset-button"
                  onClick={handleResetZoom}
                  disabled={!isZoomed}
                >
                  전체보기
                </button>
              </div>
              <span className="zoom-hint">
                드래그로 영역 확대 · 확대 후 드래그로 좌우 이동 · 휠로 확대/축소
              </span>
            </div>

            <div className="chart-container">
              {chartData.length === 0 ? (
                <div className="empty-box">
                  <strong>표시할 그래프 데이터가 없습니다.</strong>
                  <p>기록이 수집되면 그래프가 생성됩니다.</p>
                </div>
              ) : (
                <div
                  className={`chart-zoom-wrapper${isPanning ? " panning" : ""}`}
                  onWheel={handleWheelZoom}
                >
                  <ResponsiveContainer width="100%" height={260}>
                    <AreaChart
                      data={displayedData}
                      margin={{ top: 15, right: 10, left: -20, bottom: 0 }}
                      onMouseDown={handleChartMouseDown}
                      onMouseMove={handleChartMouseMove}
                      onMouseUp={handleChartMouseUp}
                      onMouseLeave={handleChartMouseUp}
                    >
                      <defs>
                        <linearGradient id="colorRate" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#9b7cff" stopOpacity={0.4} />
                          <stop offset="95%" stopColor="#9b7cff" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(119, 136, 190, 0.15)" />
                      <XAxis
                        dataKey="date"
                        stroke="#707b9f"
                        fontSize={11}
                        tickLine={false}
                        allowDuplicatedCategory={false}
                      />
                      <YAxis
                        domain={yDomain}
                        stroke="#707b9f"
                        fontSize={11}
                        tickLine={false}
                        tickFormatter={(val) => val.toLocaleString()}
                      />
                      <Tooltip content={<CustomTooltip />} />
                      <Area
                        type="monotone"
                        dataKey="rate"
                        stroke="#9b7cff"
                        strokeWidth={2}
                        fillOpacity={1}
                        fill="url(#colorRate)"
                        isAnimationActive={!isZoomed}
                      />
                      {refAreaLeft && refAreaRight ? (
                        <ReferenceArea
                          x1={refAreaLeft}
                          x2={refAreaRight}
                          strokeOpacity={0.3}
                          fill="#9b7cff"
                          fillOpacity={0.15}
                        />
                      ) : null}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </section>

          {/* 날짜별 기록 */}
          <section className="card">
            <div className="section-title">
              <div>
                <span className="label">HISTORY</span>
                <h2>날짜별 기록</h2>
              </div>
              <span className="small-text">Asia/Seoul 기준</span>
            </div>

            {records.length === 0 ? (
              <p className="empty">저장된 기록이 없습니다.</p>
            ) : (
              <div className="records">
                {records.map((record) => (
                  <div className="record" key={record.id}>
                    <div>
                      <strong>{record.record_date}</strong>
                      <span>자동 저장</span>
                    </div>

                    <strong>
                      {Number(
                        record.normalized_value ?? record.rate
                      ).toLocaleString()}{" "}
                      KRW
                    </strong>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 비교 */}
          <section className="card">
            <div className="section-title">
              <div>
                <span className="label">COMPARISON</span>
                <h2>이전 기록과 비교</h2>
              </div>
            </div>

            {!currentRecord || !previousRecord ? (
              <div className="empty-box">
                <strong>비교할 이전 데이터가 없습니다.</strong>
                <p>서로 다른 날짜의 기록이 2건 저장되면 자동으로 비교합니다.</p>
              </div>
            ) : (
              <div className="comparison">
                <div className="compare-item">
                  <span>{previousRecord.record_date}</span>
                  <strong>
                    {Number(previousRecord.rate).toLocaleString()} KRW
                  </strong>
                </div>

                <div className="arrow">→</div>

                <div className="compare-item">
                  <span>{currentRecord.record_date}</span>
                  <strong>
                    {Number(currentRecord.rate).toLocaleString()} KRW
                  </strong>
                </div>

                <div className="change">
                  <span>변화</span>
                  <strong>
                    {difference > 0 ? "▲ +" : difference < 0 ? "▼ " : ""}
                    {difference.toFixed(2)} KRW
                  </strong>
                  <small>
                    {changeRate > 0 ? "+" : ""}
                    {changeRate.toFixed(2)}%
                  </small>
                </div>
              </div>
            )}
          </section>

          {/* 검증 모드 */}
          <section className="card verification-card">
            <button
              className="verification-toggle"
              onClick={() => setVerificationOpen(!verificationOpen)}
            >
              <span>
                <span className="label">DEVELOPER</span>
                <strong>검증 모드</strong>
              </span>

              <span className="arrow-small">
                {verificationOpen ? "▲" : "▼"}
              </span>
            </button>

            {verificationOpen && (
              <div className="verification-content">
                <p>
                  실제 서비스 장애를 발생시키는 것이 아니라 장애 처리 경로를
                  안전하게 모의실험합니다.
                </p>

                <div className="test-buttons">
                  <button
                    onClick={() => runErrorTest(ERROR_MODES.timeout)}
                    disabled={isRefreshing}
                  >
                    Timeout
                  </button>
                  <button
                    onClick={() => runErrorTest(ERROR_MODES.auth)}
                    disabled={isRefreshing}
                  >
                    인증 실패
                  </button>
                  <button
                    onClick={() => runErrorTest(ERROR_MODES.limit)}
                    disabled={isRefreshing}
                  >
                    호출 제한
                  </button>
                  <button
                    onClick={() => runErrorTest(ERROR_MODES.offline)}
                    disabled={isRefreshing}
                  >
                    오프라인
                  </button>
                  <button
                    onClick={() => runErrorTest(ERROR_MODES.format)}
                    disabled={isRefreshing}
                  >
                    응답 형식 변경
                  </button>
                  <button
                    className="restore-button"
                    onClick={() => fetchRate()}
                    disabled={isRefreshing}
                  >
                    정상 상태로 복구
                  </button>
                </div>

                {/* 테스트 로그 */}
                <div className="test-log">
                  <div className="test-log-header">
                    <div>
                      <span className="label">TEST LOG</span>
                      <strong>장애 처리 과정</strong>
                    </div>

                    <button className="clear-log" onClick={clearLogs}>
                      로그 지우기
                    </button>
                  </div>

                  {logs.length === 0 ? (
                    <div className="log-empty">
                      아직 실행된 검증 테스트가 없습니다.
                    </div>
                  ) : (
                    <div className="log-list">
                      {logs.map((log) => (
                        <div className={`log-row ${log.type}`} key={log.id}>
                          <span className="log-time">{log.time}</span>
                          <span className="log-dot" />
                          <span className="log-message">{log.message}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        </main>

        <footer>
          실제 API 데이터 · Supabase 자동 기록 · 기준 시간대 Asia/Seoul
        </footer>
      </div>
    </div>
  );
}

export default App;