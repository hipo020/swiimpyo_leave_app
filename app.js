(function bindFabScrollInteraction() {
      if (window.__shimPyoFabScrollBound) return;
      window.__shimPyoFabScrollBound = true;

      let fabScrollTimer = null;
      const setFabCompact = () => {
        document.body.classList.add("fab-scrolling");
        window.clearTimeout(fabScrollTimer);
        fabScrollTimer = window.setTimeout(() => {
          document.body.classList.remove("fab-scrolling");
        }, 220);
      };

      window.addEventListener("scroll", setFabCompact, { passive: true });
      document.addEventListener("touchmove", setFabCompact, { passive: true });

      window.addEventListener("DOMContentLoaded", () => {
        document.querySelectorAll(".app, .bottom-sheet, #sheet").forEach((target) => {
          target.addEventListener("scroll", setFabCompact, { passive: true });
        });
      });
    })();

  
    (function bindMobileSettingsChip() {
      if (window.__shimPyoMobileSettingsBound) return;
      window.__shimPyoMobileSettingsBound = true;

      document.addEventListener("click", (event) => {
        const button = event.target.closest("#mobileOpenSettings");
        if (!button) return;
        if (typeof openSettings === "function") {
          openSettings();
        } else {
          document.getElementById("openSettings")?.click();
        }
      });
    })();

/************************************************************
     * 쉼표 데이터 저장 계층
     * Google 로그인 사용자별 Supabase DB 저장 버전입니다.
     ************************************************************/
    // MEMO_COLUMN_SQL:
    // alter table public.annual_leaves add column if not exists memo text;
    const SUPABASE_URL = "https://jbhbjhjdzmsmziyjxfyh.supabase.co";
    const SUPABASE_ANON_KEY = "sb_publishable_3KfcxlsmCdxaCjVbhzhtQg_PEro1iKi";
    const HOLIDAY_ADMIN_EMAIL = "hsoo9897@gmail.com";
    const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    let currentUser = null;
    let holidayMapCache = {};
    let appEventsBound = false;
    let memoColumnAvailable = true;
    let statusColumnAvailable = true;
    let workspaceLoadPromise = null;
    let workspaceLoadUserId = null;

    function normalizeReasonLabel(reason) {
      if (reason === "🏡 늦잠/휴식") return "🌿 휴식/컨디션 관리";
      return reason || "";
    }

    function normalizeLeaveStatus(status) {
      return status === "planned" ? "planned" : "confirmed";
    }

    function isPlannedLeave(leave) {
      return normalizeLeaveStatus(leave?.status) === "planned";
    }

    function escapeHTML(value) {
      return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
    }

    const escapeAttr = escapeHTML;

    function sanitizePlainText(value, maxLength = 200) {
      return String(value ?? "")
        .normalize("NFC")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .trim()
        .slice(0, maxLength);
    }

    function isValidISODate(value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
      const date = parseISO(String(value));
      return !Number.isNaN(date.getTime()) && toISO(date) === value;
    }

    function generateStableId(prefix = "leave") {
      if (window.crypto?.randomUUID) return `${prefix}_${window.crypto.randomUUID()}`;
      return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    }

    function validateLeavePayload(leave) {
      if (!leave || !isValidISODate(leave.startDate) || !isValidISODate(leave.endDate || leave.startDate)) {
        throw new Error("올바른 휴가 날짜가 필요합니다.");
      }

      const allowedTypes = new Set(leaveTypes.map(type => type.id));
      if (!allowedTypes.has(leave.type)) throw new Error("올바른 휴가 종류가 필요합니다.");
      if (!new Set(["confirmed", "planned"]).has(normalizeLeaveStatus(leave.status))) {
        throw new Error("올바른 등록 상태가 필요합니다.");
      }

      const [start, end] = clampDateRange(leave.startDate, leave.endDate || leave.startDate);
      if (start > end) throw new Error("종료일은 시작일보다 빠를 수 없어요.");
    }

    function isMemoColumnError(error) {
      const message = String(error?.message || error?.details || "").toLowerCase();
      return message.includes("memo") && (
        message.includes("column") ||
        message.includes("schema cache") ||
        message.includes("could not find")
      );
    }

    function applyOptionalLeaveColumnFallback(error) {
      const message = String(error?.message || error?.details || "").toLowerCase();
      let handled = false;

      if (message.includes("memo") && (message.includes("column") || message.includes("schema cache") || message.includes("could not find"))) {
        memoColumnAvailable = false;
        handled = true;
      }

      if (message.includes("status") && (message.includes("column") || message.includes("schema cache") || message.includes("could not find"))) {
        statusColumnAvailable = false;
        handled = true;
      }

      return handled;
    }

    function normalizeLeaveFromRow(row) {
      return {
        id: sanitizePlainText(row.id, 120),
        startDate: row.start_date,
        endDate: row.end_date || row.start_date,
        type: leaveTypes.some(type => type.id === row.type) ? row.type : "annual",
        reason: normalizeReasonLabel(sanitizePlainText(row.reason || "", 120)),
        memo: sanitizePlainText(row.memo ?? "", 200),
        status: normalizeLeaveStatus(row.status),
        createdAt: row.created_at || new Date().toISOString()
      };
    }

    function normalizeLeaveToRow(leave) {
      validateLeavePayload(leave);
      const row = {
        id: sanitizePlainText(leave.id, 120),
        user_id: currentUser.id,
        start_date: leave.startDate,
        end_date: leave.endDate || leave.startDate,
        type: leave.type,
        reason: normalizeReasonLabel(sanitizePlainText(leave.reason || "", 120)),
        created_at: leave.createdAt || new Date().toISOString()
      };

      if (memoColumnAvailable) {
        row.memo = sanitizePlainText(leave.memo || "", 200);
      }

      if (statusColumnAvailable) {
        row.status = normalizeLeaveStatus(leave.status);
      }

      return row;
    }

    function leaveSelectColumns() {
      const columns = ["id", "start_date", "end_date", "type", "reason"];
      if (memoColumnAvailable) columns.push("memo");
      if (statusColumnAvailable) columns.push("status");
      columns.push("created_at");
      return columns.join(",");
    }

    async function loadHolidaysFromSupabase() {
      const { data, error } = await supabaseClient
        .from("holidays")
        .select("date,name,is_holiday")
        .eq("is_holiday", true);

      if (error) {
        console.warn("공휴일 DB 로드 실패, 기본 내장 데이터를 사용합니다.", error);
        holidayMapCache = {};
        return;
      }

      holidayMapCache = Object.fromEntries((data || []).map(item => [item.date, item.name]));
    }

    async function listHolidaysFromSupabase() {
      const { data, error } = await supabaseClient
        .from("holidays")
        .select("date,name,is_holiday,updated_at")
        .order("date", { ascending: true });

      if (error) throw error;
      return data || [];
    }

    async function upsertHolidayToSupabase(date, name) {
      const { error } = await supabaseClient
        .from("holidays")
        .upsert({
          date,
          name,
          is_holiday: true,
          updated_at: new Date().toISOString()
        }, { onConflict: "date" });

      if (error) throw error;
    }

    async function deleteHolidayFromSupabase(date) {
      const { error } = await supabaseClient
        .from("holidays")
        .delete()
        .eq("date", date);

      if (error) throw error;
    }

    const storage = {
      async load() {
        if (!currentUser) return null;

        await loadHolidaysFromSupabase();

        const { data: settings, error: settingsError } = await supabaseClient
          .from("annual_settings")
          .select("total_leave")
          .eq("user_id", currentUser.id)
          .maybeSingle();

        if (settingsError) throw settingsError;

        if (!settings) {
          const { error: createSettingsError } = await supabaseClient
            .from("annual_settings")
            .upsert({
              user_id: currentUser.id,
              total_leave: 15,
              updated_at: new Date().toISOString()
            }, { onConflict: "user_id" });

          if (createSettingsError) throw createSettingsError;
        }

        let { data: leaves, error: leavesError } = await supabaseClient
          .from("annual_leaves")
          .select(leaveSelectColumns())
          .eq("user_id", currentUser.id)
          .order("start_date", { ascending: true });

        if (leavesError && applyOptionalLeaveColumnFallback(leavesError)) {
          const fallback = await supabaseClient
            .from("annual_leaves")
            .select(leaveSelectColumns())
            .eq("user_id", currentUser.id)
            .order("start_date", { ascending: true });

          leaves = fallback.data;
          leavesError = fallback.error;
        }

        if (leavesError) throw leavesError;

        return {
          settings: { totalLeave: Number(settings?.total_leave ?? 15) },
          leaves: (leaves || []).map(normalizeLeaveFromRow)
        };
      },

      async saveSettings(totalLeave) {
        if (!currentUser) throw new Error("로그인이 필요합니다.");

        const { error } = await supabaseClient
          .from("annual_settings")
          .upsert({
            user_id: currentUser.id,
            total_leave: Number(totalLeave),
            updated_at: new Date().toISOString()
          }, { onConflict: "user_id" });

        if (error) throw error;
      },

      async createLeave(leave) {
        if (!currentUser) throw new Error("로그인이 필요합니다.");

        // 같은 입력창에서 재시도해도 동일 id를 사용합니다.
        // 응답이 끊겼지만 DB 저장은 완료된 경우에도 중복 행이 생기지 않습니다.
        let { error } = await supabaseClient
          .from("annual_leaves")
          .upsert(normalizeLeaveToRow(leave), { onConflict: "id" });

        if (error && applyOptionalLeaveColumnFallback(error)) {
          const retry = await supabaseClient
            .from("annual_leaves")
            .upsert(normalizeLeaveToRow(leave), { onConflict: "id" });
          error = retry.error;
        }

        if (error) throw error;
        return { ...leave };
      },

      async updateLeave(leave) {
        if (!currentUser) throw new Error("로그인이 필요합니다.");

        const changes = {
          start_date: leave.startDate,
          end_date: leave.endDate || leave.startDate,
          type: leave.type,
          reason: normalizeReasonLabel(leave.reason || "")
        };

        if (statusColumnAvailable) {
          changes.status = normalizeLeaveStatus(leave.status);
        }

        if (memoColumnAvailable) {
          changes.memo = leave.memo || "";
        }

        let { error } = await supabaseClient
          .from("annual_leaves")
          .update(changes)
          .eq("user_id", currentUser.id)
          .eq("id", leave.id);

        if (error && applyOptionalLeaveColumnFallback(error)) {
          delete changes.memo;
          delete changes.status;

          const retry = await supabaseClient
            .from("annual_leaves")
            .update(changes)
            .eq("user_id", currentUser.id)
            .eq("id", leave.id);

          error = retry.error;
        }

        if (error) throw error;
        return { ...leave };
      },

      async deleteLeave(id) {
        if (!currentUser) throw new Error("로그인이 필요합니다.");

        const { error } = await supabaseClient
          .from("annual_leaves")
          .delete()
          .eq("user_id", currentUser.id)
          .eq("id", id);

        if (error) throw error;
      },

      async deleteLeavesByIds(ids) {
        if (!currentUser) throw new Error("로그인이 필요합니다.");
        if (!ids.length) return;

        const { error } = await supabaseClient
          .from("annual_leaves")
          .delete()
          .eq("user_id", currentUser.id)
          .in("id", ids);

        if (error) throw error;
      },

      async restoreLeaves(leaves) {
        if (!currentUser) throw new Error("로그인이 필요합니다.");
        if (!Array.isArray(leaves) || !leaves.length) return;

        let { error } = await supabaseClient
          .from("annual_leaves")
          .upsert(leaves.map(normalizeLeaveToRow), { onConflict: "id" });

        if (error && applyOptionalLeaveColumnFallback(error)) {
          const retry = await supabaseClient
            .from("annual_leaves")
            .upsert(leaves.map(normalizeLeaveToRow), { onConflict: "id" });
          error = retry.error;
        }

        if (error) throw error;
      },

      async remove() {
        if (!currentUser) return;

        const { error } = await supabaseClient
          .from("annual_leaves")
          .delete()
          .eq("user_id", currentUser.id);

        if (error) throw error;
      }
    };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const pad = n => String(n).padStart(2, "0");
    const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const parseISO = iso => {
      const [y, m, d] = iso.split("-").map(Number);
      return new Date(y, m - 1, d);
    };
    const addDays = (date, days) => {
      const d = new Date(date);
      d.setDate(d.getDate() + days);
      return d;
    };
    const addMonths = (date, months) => {
      const d = new Date(date);
      d.setMonth(d.getMonth() + months);
      return d;
    };

    const dayLabel = ["일", "월", "화", "수", "목", "금", "토"];
    const money = n => Number(n || 0).toFixed(2);
    const isSameDay = (a, b) => toISO(a) === toISO(b);
    const isWeekend = d => d.getDay() === 0 || d.getDay() === 6;
    const isWeekday = d => !isWeekend(d);
    const clampDateRange = (startISO, endISO) => {
      const start = parseISO(startISO);
      const end = parseISO(endISO || startISO);
      return start <= end ? [start, end] : [end, start];
    };

    const leaveTypes = [
      { id: "annual", label: "연차", icon: "🏖️", unit: 1, countable: true },
      { id: "amHalf", label: "오전반차", icon: "🌤️", unit: 0.5, countable: true },
      { id: "pmHalf", label: "오후반차", icon: "🌙", unit: 0.5, countable: true },
      { id: "quarter", label: "반반차", icon: "⏱️", unit: 0.25, countable: true },
      { id: "etc", label: "경조사/공가", icon: "🎁", unit: 0, countable: false }
    ];

    const reasonOptions = [
      "👤 개인 일정",
      "🏥 병원/검진",
      "👨‍👩‍👧 가족행사",
      "✈️ 여행",
      "🌿 휴식/컨디션 관리",
      "🎂 생일/기념일",
      "✏️ 직접 입력"
    ];

    const statusOptions = [
      {
        id: "confirmed",
        icon: "✅",
        label: "확정",
        desc: "바로 연차에서 차감해요."
      },
      {
        id: "planned",
        icon: "💜",
        label: "예정",
        desc: "미리 담아두고 나중에 확정해요."
      }
    ];


    /*
      기본 공휴일 데이터:
      - 현재 버전은 앱 내부에 직접 저장된 정적 holidaySeed 데이터를 사용합니다.
      - 새 법정공휴일, 임시공휴일, 대체공휴일이 생기면 아래 holidaySeed를 갱신해야 합니다.
      - 추후 Supabase 또는 공공데이터 API를 연결하면 주기적 업데이트 구조로 바꿀 수 있습니다.
    */
    const holidaySeed = {
      2026: {
        "2026-01-01": "신정",
        "2026-02-16": "설날 연휴",
        "2026-02-17": "설날",
        "2026-02-18": "설날 연휴",
        "2026-03-01": "삼일절",
        "2026-03-02": "대체공휴일",
        "2026-05-05": "어린이날",
        "2026-05-24": "부처님오신날",
        "2026-05-25": "대체공휴일",
        "2026-06-03": "지방선거일",
        "2026-06-06": "현충일",
        "2026-07-17": "제헌절",
        "2026-08-15": "광복절",
        "2026-08-17": "대체공휴일",
        "2026-09-24": "추석 연휴",
        "2026-09-25": "추석",
        "2026-09-26": "추석 연휴",
        "2026-09-28": "대체공휴일",
        "2026-10-03": "개천절",
        "2026-10-05": "대체공휴일",
        "2026-10-09": "한글날",
        "2026-12-25": "성탄절"
      },
      2027: {
        "2027-01-01": "신정",
        "2027-02-06": "설날 연휴",
        "2027-02-07": "설날",
        "2027-02-08": "설날 연휴",
        "2027-02-09": "대체공휴일",
        "2027-03-01": "삼일절",
        "2027-05-05": "어린이날",
        "2027-05-13": "부처님오신날",
        "2027-06-06": "현충일",
        "2027-07-17": "제헌절",
        "2027-08-15": "광복절",
        "2027-08-16": "대체공휴일",
        "2027-09-14": "추석 연휴",
        "2027-09-15": "추석",
        "2027-09-16": "추석 연휴",
        "2027-10-03": "개천절",
        "2027-10-04": "대체공휴일",
        "2027-10-09": "한글날",
        "2027-10-11": "대체공휴일",
        "2027-12-25": "성탄절",
        "2027-12-27": "대체공휴일"
      },
      2028: {
        "2028-01-01": "신정",
        "2028-01-26": "설날 연휴",
        "2028-01-27": "설날",
        "2028-01-28": "설날 연휴",
        "2028-03-01": "삼일절",
        "2028-05-02": "부처님오신날",
        "2028-05-05": "어린이날",
        "2028-06-06": "현충일",
        "2028-07-17": "제헌절",
        "2028-08-15": "광복절",
        "2028-10-02": "추석 연휴",
        "2028-10-03": "추석/개천절",
        "2028-10-04": "추석 연휴",
        "2028-10-05": "대체공휴일",
        "2028-10-09": "한글날",
        "2028-12-25": "성탄절"
      }
    };

    let state = {
      settings: {
        totalLeave: 15
      },
      leaves: []
    };

    let viewDate = new Date(today.getFullYear(), today.getMonth(), 1);
    let selectedType = "annual";
    let selectedStatus = "confirmed";
    let selectedReason = reasonOptions[0];
    let selectedDateISO = toISO(today);
    let recommendations = [];
    let recIndex = 0;
    let currentView = "calendar";
    let editingLeaveId = null;
    let editingHolidayOriginalDate = null;
    let selectedHolidayYearFilter = "all";
    let activeDialog = null;
    let lastFocusedElement = null;
    let pendingDeleteRequest = null;
    let deleteDialogPrevious = null;
    let deleteDialogFocus = null;
    let syncStatusResetTimer = null;
    let draftLeaveId = null;
    let sheetInitialSnapshot = null;
    let sheetHistoryPushed = false;
    let authListenerBound = false;
    let initializedUserId = null;
    let pendingUndoToken = 0;

    const $ = sel => document.querySelector(sel);
    const calendarEl = $("#calendar");
    const typeGrid = $("#typeGrid");
    const reasonTags = $("#reasonTags");

    function isHolidayAdmin() {
      return String(currentUser?.email || "").toLowerCase() === HOLIDAY_ADMIN_EMAIL.toLowerCase();
    }

    function syncAdminUI() {
      document.body.classList.toggle("is-holiday-admin", isHolidayAdmin());
    }

    function getHolidayMap() {
      return Object.keys(holidayMapCache).length
        ? holidayMapCache
        : Object.assign({}, ...Object.values(holidaySeed));
    }

    function getType(id) {
      return leaveTypes.find(t => t.id === id) || leaveTypes[0];
    }

    function eachDate(start, end) {
      const out = [];
      let d = new Date(start);
      while (d <= end) {
        out.push(new Date(d));
        d.setDate(d.getDate() + 1);
      }
      return out;
    }

    function calcLeaveAmount(leave, options = {}) {
      const type = getType(leave.type);
      if (isPlannedLeave(leave) && !options.includePlanned) return 0;
      if (!type.countable) return 0;

      const [start, end] = clampDateRange(leave.startDate, leave.endDate);
      const days = eachDate(start, end).filter(d => {
        const iso = toISO(d);
        return isWeekday(d) && !getHolidayMap()[iso];
      }).length;

      return days * type.unit;
    }

    function calcSummary() {
      const total = Number(state.settings.totalLeave || 0);
      const used = state.leaves.reduce((sum, leave) => sum + calcLeaveAmount(leave), 0);
      const planned = state.leaves.reduce((sum, leave) => isPlannedLeave(leave) ? sum + calcLeaveAmount(leave, { includePlanned: true }) : sum, 0);
      const remain = total - used;
      return { total, used, remain, planned };
    }

    function calcUsedExcept(leaveId) {
      return state.leaves.reduce((sum, leave) => {
        if (leaveId && leave.id === leaveId) return sum;
        return sum + calcLeaveAmount(leave);
      }, 0);
    }

    function setSyncStatus(stateName = "idle", text = "동기화됨") {
      const status = $("#syncStatus");
      const label = $("#syncStatusText");
      if (!status || !label) return;

      status.dataset.state = stateName;
      label.textContent = text;
      status.setAttribute("aria-label", text);
      status.title = stateName === "error"
        ? "클릭하면 서버의 최신 데이터를 다시 확인해요."
        : "계정과 동기화된 상태예요. 클릭하면 최신 데이터를 다시 확인해요.";
    }

    function markSyncComplete(text = "방금 저장됨") {
      clearTimeout(syncStatusResetTimer);
      setSyncStatus("synced", text);
      syncStatusResetTimer = setTimeout(() => {
        setSyncStatus("idle", "동기화됨");
      }, 4200);
    }

    async function refreshFromCloud(showSuccessToast = true) {
      if (!currentUser) return;
      if (!navigator.onLine) {
        updateOnlineStatus({ announce: true });
        return;
      }

      clearTimeout(syncStatusResetTimer);
      setSyncStatus("syncing", "최신 데이터 확인 중…");

      try {
        const saved = await storage.load();
        if (saved && typeof saved === "object") {
          state = {
            settings: Object.assign({ totalLeave: 15 }, saved.settings || {}),
            leaves: Array.isArray(saved.leaves) ? saved.leaves : []
          };
        }
        renderAll();
        markSyncComplete("최신 상태로 동기화됨");
        if (showSuccessToast) showToast("최신 데이터를 불러왔어요.", "success");
      } catch (error) {
        console.error(error);
        setSyncStatus("error", "동기화 실패 · 확인하기");
        showToast("최신 데이터를 확인하지 못했어요.", "error");
      }
    }

    async function runStorageAction(action, errorMessage = "저장 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요.") {
      clearTimeout(syncStatusResetTimer);

      if (!navigator.onLine) {
        const offlineError = new Error("OFFLINE");
        setSyncStatus("offline", "오프라인 · 아직 저장되지 않음");
        showToast("인터넷 연결이 없어 아직 저장되지 않았어요. 연결 후 다시 눌러 주세요.", "info");
        throw offlineError;
      }

      setSyncStatus("syncing", "저장 중…");

      try {
        const result = await action();
        markSyncComplete("방금 저장됨");
        return result;
      } catch (error) {
        console.error(error);
        if (!navigator.onLine || error?.message === "OFFLINE") {
          setSyncStatus("offline", "오프라인 · 아직 저장되지 않음");
        } else {
          setSyncStatus("error", "동기화 실패 · 확인하기");
          showToast(errorMessage, "error");
        }
        throw error;
      }
    }

    function updateOnlineStatus({ announce = false } = {}) {
      const online = navigator.onLine;
      document.body.classList.toggle("is-offline", !online);

      if (!online) {
        clearTimeout(syncStatusResetTimer);
        setSyncStatus("offline", "오프라인 · 저장되지 않음");
        if (announce) showToast("인터넷 연결이 끊겼어요. 작성 중인 내용은 화면에 유지돼요.", "info");
        return;
      }

      if (currentUser) markSyncComplete("인터넷 연결됨");
      if (announce) showToast("인터넷 연결이 복구됐어요. 저장 버튼을 다시 눌러 주세요.", "success");
    }

    function getSheetPreviewPayload() {
      const startDate = $("#startDate").value;
      const endDate = $("#endDate").value || startDate;
      if (!startDate) return null;

      const [start, end] = clampDateRange(startDate, endDate);
      return {
        id: editingLeaveId || "__preview__",
        startDate: toISO(start),
        endDate: toISO(end),
        type: selectedType,
        reason: selectedReason,
        status: selectedStatus
      };
    }

    function updateLeavePreview() {
      const amountEl = $("#previewAmount");
      const beforeEl = $("#previewBefore");
      const afterEl = $("#previewAfter");
      const noteEl = $("#previewNote");
      const previewMemo = $("#previewMemo");
      if (!amountEl || !beforeEl || !afterEl || !noteEl) return;

      const syncPreviewMemo = () => {
        if (!previewMemo) return;
        const memoText = ($("#leaveMemo")?.value || "").trim();
        const memoSpan = previewMemo.querySelector("span");
        if (memoSpan) {
          memoSpan.textContent = memoText.length > 42 ? `${memoText.slice(0, 42)}…` : memoText;
        }
        previewMemo.classList.toggle("active", Boolean(memoText));
      };

      const payload = getSheetPreviewPayload();
      if (!payload) {
        amountEl.textContent = "-";
        beforeEl.textContent = formatDays(calcSummary().remain);
        afterEl.textContent = "-";
        noteEl.textContent = "날짜를 선택하면 실제 차감일수를 미리 계산해요.";
        noteEl.classList.remove("warning");
        syncPreviewMemo();
        return;
      }

      const amount = calcLeaveAmount(payload);
      const total = Number(state.settings.totalLeave || 0);
      const usedExceptCurrent = calcUsedExcept(editingLeaveId);
      const before = total - usedExceptCurrent;
      const after = before - amount;
      const type = getType(payload.type);

      amountEl.textContent = selectedStatus === "planned" ? "예정" : (type.countable ? formatDays(amount) : "차감 없음");
      beforeEl.textContent = formatDays(before);
      afterEl.textContent = formatDays(after);
      syncPreviewMemo();

      if (selectedStatus === "planned") {
        noteEl.textContent = "예정 쉼은 확정 전까지 연차에서 차감하지 않아요.";
        noteEl.classList.remove("warning");
      } else if (!type.countable) {
        noteEl.textContent = "경조사/공가/기타 휴가는 기록만 남기고 연차에서는 차감하지 않아요.";
        noteEl.classList.remove("warning");
      } else if (after < 0) {
        noteEl.textContent = `잔여 연차보다 ${formatDays(Math.abs(after))} 더 많이 사용하게 돼요. 회사 정책에 맞는지 확인하고 저장해 주세요.`;
        noteEl.classList.add("warning");
      } else {
        noteEl.textContent = "주말과 공휴일은 자동으로 제외해서 실제 차감일수만 계산해요.";
        noteEl.classList.remove("warning");
      }
    }

    function getFocusableElements(container) {
      return [...container.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(el => !el.disabled && el.offsetParent !== null);
    }

    function focusFirstField(container, selector = "input, button") {
      requestAnimationFrame(() => {
        const target = container.querySelector(selector) || getFocusableElements(container)[0];
        if (target) target.focus();
      });
    }

    function closeActiveDialog() {
      if ($("#deleteConfirmModal")?.classList.contains("active")) {
        closeDeleteConfirm();
        return;
      }
      if ($("#sheet").classList.contains("active")) closeSheet();
      if ($("#settingsModal").classList.contains("active")) closeSettingsModal();
      if ($("#holidayModal")?.classList.contains("active")) closeHolidayManager();
    }

    function handleDialogKeydown(event) {
      if (!activeDialog) return;

      if (event.key === "Escape") {
        event.preventDefault();
        closeActiveDialog();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(activeDialog);
      if (!focusable.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }


    function formatDays(value) {
      const n = Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
      return `${n.toLocaleString("ko-KR", {
        minimumFractionDigits: n % 1 === 0 ? 0 : 2,
        maximumFractionDigits: 2
      })}일`;
    }

    function getLeaveReason(leave) {
      return leave.reason || "사유 없음";
    }

    function setViewMode(mode) {
      currentView = mode;
      const isReport = mode === "report";

      $("#calendarTab").classList.toggle("active", !isReport);
      $("#reportTab").classList.toggle("active", isReport);
      $("#calendarView").classList.toggle("active", !isReport);
      $("#reportView").classList.toggle("active", isReport);
      $(".main-grid").classList.toggle("report-mode", isReport);

      if (isReport) {
        renderReport();

        if (window.matchMedia("(max-width: 720px)").matches) {
          requestAnimationFrame(() => {
            const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
              ? "auto"
              : "smooth";
            $("#reportView")?.scrollIntoView({ behavior, block: "start" });
          });
        }
      }
    }

    function getReasonUsage() {
      const map = new Map();

      state.leaves.forEach(leave => {
        const amount = calcLeaveAmount(leave);
        if (amount <= 0) return;

        const reason = getLeaveReason(leave);
        map.set(reason, (map.get(reason) || 0) + amount);
      });

      return [...map.entries()]
        .map(([reason, amount]) => ({ reason, amount }))
        .sort((a, b) => b.amount - a.amount);
    }


    function getCurrentMonthUsed() {
      const y = today.getFullYear();
      const m = today.getMonth();

      return state.leaves.reduce((sum, leave) => {
        const [start, end] = clampDateRange(leave.startDate, leave.endDate);
        const dates = eachDate(start, end).filter(d => d.getFullYear() === y && d.getMonth() === m);
        if (!dates.length) return sum;

        const cloned = Object.assign({}, leave, {
          startDate: toISO(dates[0]),
          endDate: toISO(dates[dates.length - 1])
        });

        return sum + calcLeaveAmount(cloned);
      }, 0);
    }


    function getMonthlyUsage() {
      const currentYear = today.getFullYear();
      const monthly = Array.from({ length: 12 }, (_, index) => ({
        month: index + 1,
        amount: 0
      }));

      state.leaves.forEach(leave => {
        if (isPlannedLeave(leave)) return;
        const [start, end] = clampDateRange(leave.startDate, leave.endDate);
        eachDate(start, end).forEach(date => {
          if (date.getFullYear() !== currentYear) return;

          const iso = toISO(date);
          const type = getType(leave.type);
          if (!type.countable) return;
          if (!isWeekday(date) || getHolidayMap()[iso]) return;

          monthly[date.getMonth()].amount += type.unit;
        });
      });

      return monthly;
    }

    function renderMonthlyUsage() {
      const monthly = getMonthlyUsage();
      const max = Math.max(...monthly.map(item => item.amount), 0);
      const total = monthly.reduce((sum, item) => sum + item.amount, 0);

      $("#monthlyTotalText").textContent = `${today.getFullYear()}년 · ${formatDays(total)} 사용`;

      if (total <= 0) {
        $("#monthBars").innerHTML = monthly.map(item => `
          <div class="month-bar-item empty" data-month="${item.month}" data-amount="0" role="button" tabindex="0" aria-label="${item.month}월 0일 사용">
            <div class="month-column" style="height:6px"></div>
            <span class="month-value">0</span>
            <span class="month-label">${item.month}월</span>
          </div>
        `).join("");
        return;
      }

      $("#monthBars").innerHTML = monthly.map(item => {
        const height = item.amount > 0 ? Math.max(8, (item.amount / max) * 88) : 6;
        return `
          <div class="month-bar-item ${item.amount ? "" : "empty"}" title="${item.month}월 ${formatDays(item.amount)}" data-month="${item.month}" data-amount="${item.amount}" role="button" tabindex="0" aria-label="${item.month}월 ${formatDays(item.amount)} 사용">
            <div class="month-column" style="height:${height}px"></div>
            <span class="month-value">${item.amount ? formatDays(item.amount).replace("일", "") : "0"}</span>
            <span class="month-label">${item.month}월</span>
          </div>
        `;
      }).join("");
    }

    let monthTooltipTimer = null;

    function openMonthUsagePopup(month, amount, anchorEl = null) {
      const popup = $("#monthUsagePopup");
      const card = document.querySelector(".monthly-report-card");
      if (!popup || !card) return;

      $("#monthPopupTitle").textContent = `${month}월`;
      $("#monthPopupValue").textContent = `${formatDays(Number(amount) || 0)} 사용`;

      if (anchorEl) {
        const anchorRect = anchorEl.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const tooltipHalf = 48;
        const left = Math.min(
          Math.max(anchorRect.left - cardRect.left + anchorRect.width / 2, tooltipHalf),
          Math.max(tooltipHalf, cardRect.width - tooltipHalf)
        );
        const top = Math.max(anchorRect.top - cardRect.top, 32);

        popup.style.left = `${left}px`;
        popup.style.top = `${top}px`;
      }

      popup.hidden = false;
      popup.setAttribute("aria-hidden", "false");
      requestAnimationFrame(() => popup.classList.add("is-open"));

      window.clearTimeout(monthTooltipTimer);
      monthTooltipTimer = window.setTimeout(() => {
        closeMonthUsagePopup();
      }, 2600);
    }

    function closeMonthUsagePopup() {
      const popup = $("#monthUsagePopup");
      if (!popup || popup.hidden) return;
      popup.classList.remove("is-open");
      popup.setAttribute("aria-hidden", "true");
      window.clearTimeout(monthTooltipTimer);
      setTimeout(() => {
        popup.hidden = true;
      }, 160);
    }

    function renderRemainingSuggestion(remain) {
      if (remain <= 0) {
        $("#remainingSuggestionText").textContent = "남은 연차가 없어요. 다음 연차가 생기면 미리 쉬는 날을 예약해 보세요.";
        return;
      }

      const full = Math.floor(remain);
      const halfPossible = Math.floor((remain - full) / 0.5);
      const quarterPossible = Math.floor((remain % 1) / 0.25);

      const suggestions = [];
      if (full > 0) suggestions.push(`연차 ${full}번`);
      if (halfPossible > 0) suggestions.push(`반차 ${halfPossible}번`);
      if (quarterPossible > 0) suggestions.push(`반반차 ${quarterPossible}번`);

      const halfCount = Math.floor(remain / 0.5);
      const quarterCount = Math.floor(remain / 0.25);

      $("#remainingSuggestionText").textContent =
        `잔여 ${formatDays(remain)}로 ${suggestions.join(" + ")} 정도 사용할 수 있어요. 작게 나누면 반차 ${halfCount}번 또는 반반차 ${quarterCount}번으로도 쓸 수 있어요.`;
    }

    function renderPatternComment(reasonUsage) {
      const used = calcSummary().used;

      if (used <= 0 || !reasonUsage.length) {
        $("#patternCommentText").textContent = "아직 사용한 연차가 없어요. 연차를 등록하면 나의 쉼 패턴을 부드럽게 분석해드려요.";
        return;
      }

      const top = reasonUsage[0];
      const reason = top.reason;

      if (reason.includes("여행")) {
        $("#patternCommentText").textContent = "여행을 위한 쉼이 가장 많아요. 긴 휴가를 만들 수 있는 징검다리 연휴를 함께 확인해 보세요.";
      } else if (reason.includes("병원") || reason.includes("검진")) {
        $("#patternCommentText").textContent = "건강 관리를 위한 쉼이 많아요. 반차나 오전 시간을 활용한 계획이 잘 맞는 패턴이에요.";
      } else if (reason.includes("휴식") || reason.includes("늦잠")) {
        $("#patternCommentText").textContent = "회복을 위한 쉼이 많아요. 한 달에 한 번 작은 쉼표를 미리 예약해두면 좋아요.";
      } else if (reason.includes("가족")) {
        $("#patternCommentText").textContent = "가족 일정과 함께한 쉼이 많아요. 주말과 붙여 쓰는 연차 계획이 잘 어울려요.";
      } else if (reason.includes("생일") || reason.includes("기념일")) {
        $("#patternCommentText").textContent = "기념일을 챙기는 쉼이 눈에 띄어요. 중요한 날을 미리 등록해두면 더 여유로워요.";
      } else {
        $("#patternCommentText").textContent = `${reason} 사유가 가장 많아요. 나에게 필요한 쉼의 흐름이 조금씩 쌓이고 있어요.`;
      }
    }

    function renderReport() {
      const { total, used, remain } = calcSummary();
      const percent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
      const radius = 58;
      const circumference = 2 * Math.PI * radius;
      const usedLength = circumference * (percent / 100);
      const remainLength = circumference - usedLength;

      $("#donutUsed").style.strokeDasharray = `${usedLength} ${remainLength}`;
      $("#donutRemain").textContent = formatDays(remain);
      $("#donutPercent").textContent = `${percent.toFixed(1)}% 사용`;
      $("#donutTooltipText").textContent = `${formatDays(used)} / ${formatDays(total)} · 잔여 ${formatDays(remain)}`;

      $("#reportTotal").textContent = formatDays(total);
      $("#reportUsed").textContent = formatDays(used);
      $("#reportRemain").textContent = formatDays(remain);
      $("#reportPercent").textContent = `${percent.toFixed(1)}%`;

      const reasonUsage = getReasonUsage();
      const topReason = reasonUsage[0];

      if (used <= 0) {
        $("#reportInsight").textContent = "아직 사용한 연차가 없어요. 첫 쉼표를 기록하면 이곳에 사용 패턴이 보여요.";
      } else if (topReason) {
        const monthUsed = getCurrentMonthUsed();
        $("#reportInsight").textContent = `가장 많이 사용한 사유는 ${topReason.reason}이고, 총 ${formatDays(topReason.amount)}를 사용했어요. 이번 달에는 ${formatDays(monthUsed)}를 사용했어요.`;
      }

      $("#reasonTotalText").textContent = `${formatDays(used)} 사용`;

      renderMonthlyUsage();
      renderRemainingSuggestion(remain);
      renderPatternComment(reasonUsage);

      if (!reasonUsage.length) {
        $("#reasonBars").innerHTML = `<div class="empty-state">아직 사유별 사용 데이터가 없어요.<br>연차를 등록하면 자동으로 분석돼요.</div>`;
        return;
      }

      const max = Math.max(...reasonUsage.map(item => item.amount), 1);
      $("#reasonBars").innerHTML = reasonUsage.map(item => {
        const width = Math.max(6, (item.amount / max) * 100);
        return `
          <div class="reason-bar-item">
            <div class="reason-bar-top">
              <span>${escapeHTML(item.reason)}</span>
              <span>${formatDays(item.amount)}</span>
            </div>
            <div class="reason-track">
              <div class="reason-fill" style="width:${width}%"></div>
            </div>
          </div>
        `;
      }).join("");
    }

    function renderDashboard() {
      const { total, used, remain, planned } = calcSummary();
      $("#totalLeave").textContent = money(total);
      $("#usedLeave").textContent = money(used);
      $("#remainLeave").textContent = money(remain);
      $("#totalInput").value = total;

      const percent = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
      const usageText = $("#leaveUsageText");
      const usageBar = $("#leaveUsageBar");
      const usageHint = $("#leaveUsageHint");

      if (usageText) usageText.textContent = `${Math.round(percent)}% 사용`;
      if (usageBar) usageBar.style.width = `${percent}%`;
      if (usageHint) {
        if (used <= 0) {
          usageHint.textContent = "아직 사용한 연차가 없어요.";
        } else if (remain <= 0) {
          usageHint.textContent = "올해 연차를 모두 사용했어요.";
        } else {
          usageHint.textContent = planned > 0
            ? `예정 쉼 ${formatDays(planned)}을 확정하면 잔여 ${formatDays(remain - planned)}가 예상돼요.`
            : `남은 연차 ${formatDays(remain)}를 계획적으로 나눠 쓸 수 있어요.`;
        }
      }
    }

    function renderTypeButtons() {
      typeGrid.innerHTML = leaveTypes.map(t => `
        <button class="type-btn ${selectedType === t.id ? "active" : ""}" data-type="${t.id}">
          ${t.icon} ${t.label}
          <small>${t.countable ? `-${t.unit}일` : "차감 없음"}</small>
        </button>
      `).join("");

      typeGrid.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", () => {
          selectedType = btn.dataset.type;
          renderTypeButtons();
          updateLeavePreview();
        });
      });
    }


    function renderStatusButtons() {
      const statusGrid = document.getElementById("statusGrid");
      const helper = document.getElementById("statusHelper");
      if (!statusGrid) return;

      statusGrid.innerHTML = statusOptions.map(option => `
        <button class="status-btn ${selectedStatus === option.id ? "active" : ""}" data-status="${option.id}" type="button">
          <strong>${option.icon} ${option.label}</strong>
          <span>${option.desc}</span>
        </button>
      `).join("");

      statusGrid.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", () => {
          selectedStatus = btn.dataset.status;
          renderStatusButtons();
          updateLeavePreview();
        });
      });

      if (helper) {
        helper.textContent = selectedStatus === "planned"
          ? "예정 쉼은 확정 전까지 사용한 연차에 포함하지 않아요."
          : "확정 쉼은 저장 즉시 사용한 연차에 포함돼요.";
      }
    }

    function renderReasonTags() {
      reasonTags.innerHTML = reasonOptions.map(reason => `
        <button type="button" class="reason-tag ${selectedReason === reason ? "active" : ""}" data-reason="${reason}">
          ${reason}
        </button>
      `).join("");

      reasonTags.querySelectorAll("button").forEach(btn => {
        btn.addEventListener("click", () => {
          selectedReason = btn.dataset.reason;
          renderReasonTags();
          updateCustomReasonMotion();
          updateLeavePreview();
        });
      });

      updateCustomReasonMotion();
    }

    function leavesForDate(iso) {
      return state.leaves.filter(l => {
        const [start, end] = clampDateRange(l.startDate, l.endDate);
        const date = parseISO(iso);
        return date >= start && date <= end;
      });
    }


    function leavePositionOnDate(leave, iso) {
      if (leave.startDate === leave.endDate) return "single";
      if (iso === leave.startDate) return "start";
      if (iso === leave.endDate) return "end";
      return "mid";
    }

    function leaveDurationLabel(leave) {
      const [start, end] = clampDateRange(leave.startDate, leave.endDate);
      const holidayMap = getHolidayMap();
      const type = getType(leave.type);
      const days = eachDate(start, end).filter(d => {
        if (!type.countable) return true;
        return isWeekday(d) && !holidayMap[toISO(d)];
      }).length;

      if (days <= 1) return "";
      return `${days}일`;
    }

    function calendarEventLabel(leave, iso) {
      const type = getType(leave.type);
      const position = leavePositionOnDate(leave, iso);

      if (position === "mid" || position === "end") {
        return "";
      }

      const baseLabel = isMobileViewport()
        ? `${type.icon} ${getCompactLeaveTypeLabel(leave.type)}`
        : `${type.icon} ${type.label}`;
      const duration = leaveDurationLabel(leave);
      const memoDot = leave.memo ? " 💬" : "";
      const statusPrefix = isPlannedLeave(leave) ? "예정 · " : "";
      return duration && !isMobileViewport()
        ? `${statusPrefix}${baseLabel}${memoDot} ${duration}`
        : `${statusPrefix}${baseLabel}${memoDot}`;
    }

    function calendarEventClass(leave, iso) {
      const type = getType(leave.type);
      const position = leavePositionOnDate(leave, iso);
      const classes = ["event-pill"];

      if (!type.countable) classes.push("free");
      if (isPlannedLeave(leave)) classes.push("planned");
      if (leave.memo) classes.push("has-memo");
      if (position === "start") classes.push("range-start");
      if (position === "mid") classes.push("range-mid");
      if (position === "end") classes.push("range-end");

      return classes.join(" ");
    }

    function renderCalendar() {
      const y = viewDate.getFullYear();
      const m = viewDate.getMonth();
      const first = new Date(y, m, 1);
      const last = new Date(y, m + 1, 0);
      const startBlank = first.getDay();
      const totalCells = Math.ceil((startBlank + last.getDate()) / 7) * 7;
      const holidayMap = getHolidayMap();

      $("#monthTitle").textContent = `${y}년 ${m + 1}월`;
      $("#monthCount").textContent = `${state.leaves.filter(l => {
        const s = parseISO(l.startDate);
        const e = parseISO(l.endDate);
        return (s.getFullYear() === y && s.getMonth() === m) || (e.getFullYear() === y && e.getMonth() === m);
      }).length}건`;

      const cells = [];
      for (let i = 0; i < totalCells; i++) {
        const dayNum = i - startBlank + 1;
        if (dayNum < 1 || dayNum > last.getDate()) {
          cells.push(`<button type="button" class="day empty"></button>`);
          continue;
        }

        const date = new Date(y, m, dayNum);
        const iso = toISO(date);
        const dow = date.getDay();
        const holidayName = holidayMap[iso];
        const list = leavesForDate(iso);
        const isTodayDate = isSameDay(date, today);
        const classes = [
          "day",
          dow === 0 ? "sun" : "",
          dow === 6 ? "sat" : "",
          holidayName ? "holiday" : "",
          list.length ? "has-leaves" : "",
          isTodayDate ? "today" : ""
        ].filter(Boolean).join(" ");

        cells.push(`
          <button type="button" class="${classes}" data-date="${iso}" aria-label="${iso} 휴가 등록" ${isTodayDate ? 'aria-current="date"' : ""}>
            <span class="day-number">${dayNum}</span>
            ${holidayName ? `<span class="holiday-dot">♥</span><span class="holiday-name">${escapeHTML(holidayName)}</span>` : ""}
            <span class="events">
              ${list.slice(0, 2).map(l => {
                return `<span class="${calendarEventClass(l, iso)}" data-edit-id="${escapeAttr(l.id)}">${escapeHTML(calendarEventLabel(l, iso))}</span>`;
              }).join("")}
              ${list.length > 2 ? `<span class="event-pill">+${list.length - 2}</span>` : ""}
            </span>
          </button>
        `);
      }

      calendarEl.innerHTML = cells.join("");

      calendarEl.querySelectorAll("[data-edit-id]").forEach(eventEl => {
        eventEl.addEventListener("click", (e) => {
          e.stopPropagation();
          openEditSheet(eventEl.dataset.editId);
        });
      });

      calendarEl.querySelectorAll(".day:not(.empty)").forEach(day => {
        day.addEventListener("click", () => {
          const dateISO = day.dataset.date;
          if (isMobileViewport() && leavesForDate(dateISO).length) {
            openDaySummary(dateISO);
          } else {
            openSheet(dateISO);
          }
        });
      });
    }

    function formatKoreanDate(iso, includeYear = false) {
      const d = parseISO(iso);
      const base = `${d.getMonth() + 1}/${d.getDate()}(${dayLabel[d.getDay()]})`;
      return includeYear ? `${d.getFullYear()}년 ${base}` : base;
    }

    let mobileSummaryDateISO = null;

    function closeDaySummary() {
      const summary = document.getElementById("mobileDaySummary");
      if (!summary) return;
      summary.classList.remove("active");
      mobileSummaryDateISO = null;
    }

    function openDaySummary(dateISO) {
      const summary = document.getElementById("mobileDaySummary");
      const title = document.getElementById("mobileDaySummaryTitle");
      const sub = document.getElementById("mobileDaySummarySub");
      const list = document.getElementById("mobileDaySummaryList");

      if (!summary || !title || !sub || !list) return;

      const leaves = leavesForDate(dateISO);
      if (!leaves.length) {
        openSheet(dateISO);
        return;
      }

      mobileSummaryDateISO = dateISO;
      title.textContent = formatKoreanDate(dateISO, true);
      sub.textContent = `${leaves.length}개의 쉼이 등록되어 있어요.`;

      list.innerHTML = leaves.map(l => {
        const type = getType(l.type);
        const reason = l.reason || "사유 없음";
        const dateText = l.startDate === l.endDate
          ? formatKoreanDate(l.startDate)
          : `${formatKoreanDate(l.startDate)} ~ ${formatKoreanDate(l.endDate)}`;

        return `
          <div class="leave-item">
            <div class="leave-date">${parseISO(l.startDate).getDate()}</div>
            <div class="leave-meta">
              <strong>${type.icon} ${type.label}</strong>
              <span>${escapeHTML(dateText)} · ${escapeHTML(reason)}</span>
            </div>
            <div class="leave-actions">
              <button type="button" class="edit-btn" data-id="${escapeAttr(l.id)}" aria-label="수정">✎</button>
              <button type="button" class="delete-btn" data-id="${escapeAttr(l.id)}" aria-label="삭제">×</button>
            </div>
          </div>
        `;
      }).join("");

      list.querySelectorAll(".edit-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          closeDaySummary();
          openEditSheet(btn.dataset.id);
        });
      });

      list.querySelectorAll(".delete-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          openDeleteConfirm({
            ids: [btn.dataset.id],
            title: "이 쉼 기록을 삭제할까요?",
            message: "선택한 날짜의 기록만 삭제돼요.",
            successMessage: "쉼 기록을 삭제했어요.",
            afterDelete: () => {
              const stillHasLeaves = leavesForDate(dateISO).length;
              if (stillHasLeaves) openDaySummary(dateISO);
              else closeDaySummary();
            }
          });
        });
      });

      summary.classList.add("active");
    }

    function renderUpcoming() {
      const nowISO = toISO(today);
      const futureLeaves = state.leaves
        .filter(l => !isPlannedLeave(l) && (l.endDate || l.startDate) >= nowISO)
        .sort((a, b) => a.startDate.localeCompare(b.startDate))
        .slice(0, 6);

      const hasFuture = futureLeaves.length > 0;

      document.body.classList.toggle("has-upcoming-leaves", hasFuture);
      document.body.classList.toggle("show-mobile-upcoming", hasFuture);

      const desktopList = document.getElementById("upcomingList");
      const mobileList = document.getElementById("mobileUpcomingList");
      const mobileTitle = document.getElementById("mobileUpcomingTitle");

      if (mobileTitle) {
        mobileTitle.innerHTML = `다가오는 쉼 <span>먼저 확인하기</span>`;
      }

      const emptyHtml = `<div class="empty-state">아직 확정된 다가오는 쉼이 없어요.<br>예정 쉼을 확정하거나 + 버튼으로 휴가를 등록해 보세요.</div>`;

      function makeItemHtml(list) {
        return list.map(l => {
          const type = getType(l.type);
          const reason = l.reason || "사유 없음";
          const dateText = l.startDate === l.endDate
            ? formatKoreanDate(l.startDate)
            : `${formatKoreanDate(l.startDate)} ~ ${formatKoreanDate(l.endDate)}`;

          return `
            <div class="leave-item ${isPlannedLeave(l) ? "planned" : ""}">
              <div class="leave-date">${parseISO(l.startDate).getDate()}</div>
              <div class="leave-meta">
                <strong>${type.icon} ${type.label}${isPlannedLeave(l) ? `<span class="status-badge">예정</span>` : ""}${l.memo ? `<span class="memo-indicator" title="메모 있음">💬</span>` : ""}</strong>
                <span>${escapeHTML(dateText)} · ${escapeHTML(reason)}</span>
                ${l.memo ? `<span class="leave-memo">메모: ${escapeHTML(l.memo)}</span>` : ""}
              </div>
              <div class="leave-actions">
                <button type="button" class="edit-btn" data-id="${escapeAttr(l.id)}" aria-label="수정">✎</button>
                <button type="button" class="delete-btn" data-id="${escapeAttr(l.id)}" aria-label="삭제">×</button>
              </div>
            </div>
          `;
        }).join("");
      }

      if (desktopList) {
        desktopList.innerHTML = hasFuture ? makeItemHtml(futureLeaves) : emptyHtml;
      }

      if (mobileList) {
        mobileList.innerHTML = hasFuture ? makeItemHtml(futureLeaves) : "";
      }

      document.querySelectorAll("#upcomingList .edit-btn, #mobileUpcomingList .edit-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          openEditSheet(btn.dataset.id);
        });
      });

      document.querySelectorAll("#upcomingList .delete-btn, #mobileUpcomingList .delete-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          openDeleteConfirm({
            ids: [btn.dataset.id],
            title: "다가오는 쉼을 삭제할까요?",
            message: "삭제하면 캘린더와 연차 리포트에서도 사라져요.",
            successMessage: "다가오는 쉼을 삭제했어요."
          });
        });
      });
    }


    function renderPlannedLeaves() {
      const nowISO = toISO(today);
      const plannedLeaves = state.leaves
        .filter(l => isPlannedLeave(l) && (l.endDate || l.startDate) >= nowISO)
        .sort((a, b) => a.startDate.localeCompare(b.startDate));

      const list = document.getElementById("plannedLeaveList");
      const count = document.getElementById("plannedCount");
      const amountEl = document.getElementById("plannedAmount");
      const afterEl = document.getElementById("plannedAfterRemain");
      if (!list) return;

      const { remain } = calcSummary();
      const plannedAmount = plannedLeaves.reduce((sum, leave) => sum + calcLeaveAmount(leave, { includePlanned: true }), 0);

      if (count) count.textContent = `${plannedLeaves.length}건`;
      if (amountEl) amountEl.textContent = formatDays(plannedAmount);
      if (afterEl) afterEl.textContent = formatDays(remain - plannedAmount);

      if (!plannedLeaves.length) {
        list.innerHTML = `<div class="planned-empty">아직 예정 쉼이 없어요.<br>쉬고 싶은 날을 등록할 때 상태를 ‘예정’으로 선택해 보세요.</div>`;
      } else {
        list.innerHTML = plannedLeaves.slice(0, 5).map(leave => {
          const type = getType(leave.type);
          const reason = leave.reason || "사유 없음";
          const dateText = leave.startDate === leave.endDate
            ? formatKoreanDate(leave.startDate)
            : `${formatKoreanDate(leave.startDate)} ~ ${formatKoreanDate(leave.endDate)}`;
          const amount = calcLeaveAmount(leave, { includePlanned: true });

          return `
            <div class="planned-item">
              <div class="planned-date">${parseISO(leave.startDate).getDate()}</div>
              <div class="planned-meta">
                <strong>${type.icon} ${type.label}${leave.memo ? `<span class="memo-indicator" title="메모 있음">💬</span>` : ""}</strong>
                <span>${escapeHTML(dateText)} · ${escapeHTML(reason)} · 예정 ${formatDays(amount)}</span>
                ${leave.memo ? `<span class="leave-memo">메모: ${escapeHTML(leave.memo)}</span>` : ""}
              </div>
              <div class="planned-actions">
                <button class="confirm-planned-btn" data-id="${escapeAttr(leave.id)}" type="button">확정하기</button>
                <button class="planned-edit-btn" data-id="${escapeAttr(leave.id)}" type="button">수정</button>
              </div>
            </div>
          `;
        }).join("");
      }

      list.querySelectorAll(".confirm-planned-btn").forEach(btn => {
        btn.addEventListener("click", async () => {
          const leave = state.leaves.find(item => item.id === btn.dataset.id);
          if (!leave) return;
          const next = { ...leave, status: "confirmed" };
          const saved = await runStorageAction(
            () => storage.updateLeave(next),
            "예정 쉼 확정 중 오류가 발생했어요."
          );
          state.leaves = state.leaves.map(item => item.id === leave.id ? { ...next, ...saved, status: "confirmed" } : item);
          renderAll();
          showToast("예정 쉼을 확정했어요.");
        });
      });

      list.querySelectorAll(".planned-edit-btn").forEach(btn => {
        btn.addEventListener("click", () => openEditSheet(btn.dataset.id));
      });
    }

    function isRestDay(date, holidayMap) {
      return isWeekend(date) || Boolean(holidayMap[toISO(date)]);
    }

    function expandRestBlock(date, direction, holidayMap) {
      let current = new Date(date);
      let lastRest = new Date(date);

      while (true) {
        if (isRestDay(current, holidayMap)) {
          lastRest = new Date(current);
          current = addDays(current, direction);
        } else {
          return lastRest;
        }
      }
    }

    function countContinuousDays(startDate, endDate) {
      return Math.round((endDate - startDate) / 86400000) + 1;
    }

    function isWithinRecommendationRange(iso) {
      const d = parseISO(iso);
      const end = addMonths(today, 6);
      end.setHours(23, 59, 59, 999);
      return d > today && d <= end;
    }

    function isValidRecommendationLeaveDate(iso, holidayMap) {
      const date = parseISO(iso);
      return isWithinRecommendationRange(iso) && isWeekday(date) && !holidayMap[iso];
    }

    function getRecommendationRangeDates(leaveDates, holidayMap) {
      const sortedLeaveDates = leaveDates.slice().sort();
      const firstLeave = parseISO(sortedLeaveDates[0]);
      const lastLeave = parseISO(sortedLeaveDates[sortedLeaveDates.length - 1]);

      let start = new Date(firstLeave);
      let prev = addDays(start, -1);
      while (isRestDay(prev, holidayMap)) {
        start = new Date(prev);
        prev = addDays(prev, -1);
      }

      let end = new Date(lastLeave);
      let next = addDays(end, 1);
      while (isRestDay(next, holidayMap)) {
        end = new Date(next);
        next = addDays(next, 1);
      }

      return { start, end };
    }

    function hasWeekdayHolidayInRestRange(rec, holidayMap) {
      if (!rec || !Array.isArray(rec.leaveDates) || !rec.leaveDates.length) return false;

      const leaveDateSet = new Set(rec.leaveDates);
      const { start, end } = getRecommendationRangeDates(rec.leaveDates, holidayMap);

      for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
        const iso = toISO(d);
        if (!leaveDateSet.has(iso) && isWeekday(d) && holidayMap[iso]) {
          return true;
        }
      }

      return false;
    }

    function pushUniqueRecommendation(target, rec, seen) {
      const holidayMap = getHolidayMap();
      const leaveDates = Array.isArray(rec.leaveDates) ? rec.leaveDates.slice().sort() : [];
      const key = leaveDates.join(",");

      if (!key || seen.has(key)) return;
      if (!leaveDates.every(iso => isValidRecommendationLeaveDate(iso, holidayMap))) return;
      if (!hasWeekdayHolidayInRestRange(rec, holidayMap)) return;

      seen.add(key);
      target.push(Object.assign({}, rec, { leaveDates }));
    }

    function buildRecommendations() {
      const holidayMap = getHolidayMap();
      const sixMonthsLater = addMonths(today, 6);
      const recs = [];
      const seen = new Set();

      // 1) 오늘 이후 6개월 안의 '평일 공휴일을 포함한 3일 이상 쉼' 추천
      //    단순히 금요일/월요일에 연차를 붙여 주말과 3일 쉬는 경우는 제외합니다.
      for (let d = addDays(today, 1); d <= sixMonthsLater; d = addDays(d, 1)) {
        if (!isWeekday(d)) continue;

        const iso = toISO(d);
        if (holidayMap[iso]) continue;

        const { start: blockStart, end: blockEnd } = getRecommendationRangeDates([iso], holidayMap);
        const totalDays = countContinuousDays(blockStart, blockEnd);

        if (totalDays < 3) continue;

        pushUniqueRecommendation(recs, {
          title: `${formatKoreanDate(iso, true)} 하루 쓰면`,
          leaveDates: [iso],
          result: `${totalDays}일 연속 쉼 가능`,
          desc: `${formatKoreanDate(toISO(blockStart), true)}부터 ${formatKoreanDate(toISO(blockEnd), true)}까지 이어지는 평일 공휴일 징검다리예요.`
        }, seen);
      }

      // 2) 주요 명절/연휴 전후로 2~3일 연차를 붙이는 추천
      const manualRecs = [
        {
          title: "2026년 설날 전후",
          leaveDates: ["2026-02-19", "2026-02-20"],
          result: "2일 사용으로 긴 설 연휴",
          desc: "2/16~2/18 설날 연휴 뒤 2/19, 2/20을 쓰면 주말까지 포근하게 이어져요."
        },
        {
          title: "2026년 추석 앞쪽",
          leaveDates: ["2026-09-21", "2026-09-22", "2026-09-23"],
          result: "3일 사용으로 긴 추석 쉼",
          desc: "9/24~9/28 추석·대체공휴일 앞에 3일을 붙이면 9/19부터 9/28까지 연결돼요."
        },
        {
          title: "2027년 설날 전후",
          leaveDates: ["2027-02-10", "2027-02-11", "2027-02-12"],
          result: "3일 사용으로 긴 겨울 쉼",
          desc: "설 연휴와 주말 사이를 연결해 여유로운 겨울 휴가를 만들 수 있어요."
        },
        {
          title: "2027년 5월 징검다리",
          leaveDates: ["2027-05-14"],
          result: "하루 사용으로 4일 연속 쉼 가능",
          desc: "부처님오신날 다음 금요일에 연차를 쓰면 5/13부터 5/16까지 이어져요."
        },
        {
          title: "2027년 추석 앞뒤",
          leaveDates: ["2027-09-17"],
          result: "하루 사용으로 추석 뒤 긴 쉼",
          desc: "추석 연휴 뒤 금요일 하루를 붙이면 주말까지 자연스럽게 연결돼요."
        },
        {
          title: "2027년 10월 공휴일 연결",
          leaveDates: ["2027-10-05", "2027-10-06", "2027-10-07", "2027-10-08"],
          result: "4일 사용으로 긴 가을 쉼",
          desc: "개천절 대체휴일과 한글날 대체휴일 사이를 연결하는 가을 황금휴가예요."
        },
        {
          title: "2027년 크리스마스 전후",
          leaveDates: ["2027-12-24"],
          result: "하루 사용으로 연말 4일 쉼",
          desc: "성탄절과 대체공휴일 앞 금요일을 활용하면 연말 쉼이 길어져요."
        },
        {
          title: "2028년 설날 전후",
          leaveDates: ["2028-01-24", "2028-01-25"],
          result: "2일 사용으로 긴 설 연휴",
          desc: "설 연휴 앞 월·화에 연차를 붙이면 주말부터 설 연휴까지 길게 쉴 수 있어요."
        },
        {
          title: "2028년 5월 가정의 달",
          leaveDates: ["2028-05-03", "2028-05-04"],
          result: "2일 사용으로 긴 5월 쉼",
          desc: "부처님오신날과 어린이날 사이를 연결하면 가족과 보내는 미니 휴가가 완성돼요."
        },
        {
          title: "2028년 10월 추석 연휴",
          leaveDates: ["2028-10-06"],
          result: "하루 사용으로 긴 가을 쉼",
          desc: "추석·개천절 연휴 뒤 하루를 붙이면 한글날까지 이어지는 긴 휴식을 만들 수 있어요."
        }
      ];

      manualRecs.forEach(rec => pushUniqueRecommendation(recs, rec, seen));

      recommendations = recs
        .filter(rec => rec.leaveDates.length && rec.leaveDates.every(isWithinRecommendationRange))
        .sort((a, b) => a.leaveDates[0].localeCompare(b.leaveDates[0]));

      recIndex = 0;
    }


    function extractFirstNumber(text) {
      const match = String(text || "").match(/(\d+(?:\.\d+)?)/);
      return match ? Number(match[1]) : null;
    }

    function getRecommendationUseDays(rec) {
      if (!rec || !Array.isArray(rec.leaveDates)) return "-";
      return `${rec.leaveDates.length}일`;
    }

    function getRecommendationRestDays(rec) {
      const n = extractFirstNumber(rec?.result);
      return n ? `${n}일` : "-";
    }

    function getRecommendationDateLabel(rec) {
      if (!rec || !Array.isArray(rec.leaveDates) || !rec.leaveDates.length) return "-";
      if (rec.leaveDates.length === 1) return formatKoreanDate(rec.leaveDates[0], true);
      return `${formatKoreanDate(rec.leaveDates[0], true)} ~ ${formatKoreanDate(rec.leaveDates[rec.leaveDates.length - 1])}`;
    }

    function getRecommendationRange(rec) {
      if (!rec || !Array.isArray(rec.leaveDates) || !rec.leaveDates.length) {
        return {
          start: "-",
          end: "-",
          startISO: null,
          endISO: null,
          totalDays: 0
        };
      }

      const holidayMap = getHolidayMap();
      const leaveDates = rec.leaveDates.slice().sort();
      const { start, end } = getRecommendationRangeDates(leaveDates, holidayMap);

      return {
        start: formatKoreanDate(toISO(start), true),
        end: formatKoreanDate(toISO(end), false),
        startISO: toISO(start),
        endISO: toISO(end),
        totalDays: countContinuousDays(start, end)
      };
    }

    function isMobileViewport() {
      return window.matchMedia("(max-width: 720px)").matches;
    }

    function getCompactLeaveTypeLabel(typeId) {
      const map = {
        annual: "연차",
        amHalf: "오전",
        pmHalf: "오후",
        quarter: "반반",
        etc: "기타"
      };
      return map[typeId] || getType(typeId).label;
    }

    function setMiniPanelExpanded(expanded) {
      const panel = $("#miniPanel");
      const btn = $("#toggleMiniPanel");
      if (!panel || !btn) return;
      if (!isMobileViewport()) {
        panel.classList.remove("mobile-collapsed");
        btn.style.display = "none";
        btn.setAttribute("aria-expanded", "true");
        btn.textContent = "펼치기";
        return;
      }
      btn.style.display = "inline-flex";
      panel.classList.toggle("mobile-collapsed", !expanded);
      btn.setAttribute("aria-expanded", String(expanded));
      btn.textContent = expanded ? "접기" : "펼치기";
    }

    function setRecommendationExpanded(expanded) {
      const card = $("#recommendCard");
      const btn = $("#toggleRecommendCard");
      if (!card || !btn) return;
      if (!isMobileViewport()) {
        card.classList.remove("mobile-collapsed");
        btn.style.display = "none";
        btn.setAttribute("aria-expanded", "true");
        btn.textContent = "자세히 보기";
        return;
      }
      btn.style.display = "inline-flex";
      card.classList.toggle("mobile-collapsed", !expanded);
      btn.setAttribute("aria-expanded", String(expanded));
      btn.textContent = expanded ? "간단히 보기" : "자세히 보기";
    }

    function syncMobilePanels() {
      const miniPanel = $("#miniPanel");
      const recommendCard = $("#recommendCard");
      if (isMobileViewport()) {
        if (miniPanel && !miniPanel.dataset.initialized) {
          miniPanel.dataset.initialized = "true";
          setMiniPanelExpanded(false);
        } else if (miniPanel) {
          setMiniPanelExpanded(!miniPanel.classList.contains("mobile-collapsed"));
        }
        if (recommendCard && !recommendCard.dataset.initialized) {
          recommendCard.dataset.initialized = "true";
          setRecommendationExpanded(false);
        } else if (recommendCard) {
          setRecommendationExpanded(!recommendCard.classList.contains("mobile-collapsed"));
        }
      } else {
        setMiniPanelExpanded(true);
        setRecommendationExpanded(true);
      }
    }

    function renderRecommendation() {
      // 이전 추천 UI가 제거된 배포본에서도 남은 로직이 오류를 만들지 않도록 방어합니다.
      if (!$("#recommendCount")) return;
      document.body.classList.toggle("has-recommendations", recommendations.length > 0);
      if (!recommendations.length) {
        $("#recommendCount").textContent = "추천 없음";
        $("#recommendUseDays").textContent = "-";
        $("#recommendRestDays").textContent = "-";
        $("#recommendStartDate").textContent = "-";
        $("#recommendEndDate").textContent = "-";
        $("#recommendText").textContent = "6개월 안에 평일 공휴일과 연결되는 추천이 없어요.";
        $("#recommendDesc").textContent = "주말만 붙는 추천은 제외하고, 평일 빨간날을 활용한 징검다리만 보여줘요.";
        return;
      }

      const safeIndex = recIndex % recommendations.length;
      const rec = recommendations[safeIndex];
      const range = getRecommendationRange(rec);
      const leaveCount = rec.leaveDates.length;
      const restDays = range.totalDays || extractFirstNumber(rec?.result) || 0;

      $("#recommendCount").textContent = `추천 ${safeIndex + 1}/${recommendations.length}`;
      $("#recommendUseDays").textContent = `${leaveCount}개`;
      $("#recommendRestDays").textContent = `${restDays}일`;
      $("#recommendStartDate").textContent = range.start;
      $("#recommendEndDate").textContent = range.end;
      $("#recommendText").textContent = `연차 ${leaveCount}개로 총 ${restDays}일 쉴 수 있어요.`;
      $("#recommendDesc").textContent = `${rec.leaveDates.map(d => formatKoreanDate(d)).join(", ")}에 연차를 붙이는 추천이에요.`;
    }


    function updateCustomReasonMotion() {
      const wrap = $("#customReasonWrap");
      const input = $("#customReason");
      const isCustom = selectedReason.includes("직접 입력");

      wrap.classList.toggle("active", isCustom);

      if (isCustom) {
        setTimeout(() => input.focus(), 220);
      } else {
        input.value = "";
      }
    }

    function pushSheetHistoryState() {
      try {
        history.pushState({ ...(history.state || {}), shimPyoDialog: "sheet" }, "", window.location.href);
        sheetHistoryPushed = true;
        return true;
      } catch (error) {
        console.warn("입력창 뒤로가기 상태를 만들지 못했어요.", error);
        sheetHistoryPushed = false;
        return false;
      }
    }

    function captureSheetSnapshot() {
      return JSON.stringify({
        startDate: $("#startDate")?.value || "",
        endDate: $("#endDate")?.value || "",
        type: selectedType,
        status: selectedStatus,
        reasonChoice: selectedReason,
        customReason: $("#customReason")?.value || "",
        memo: $("#leaveMemo")?.value || ""
      });
    }

    function markSheetClean() {
      sheetInitialSnapshot = captureSheetSnapshot();
    }

    function isSheetDirty() {
      return $("#sheet")?.classList.contains("active")
        && sheetInitialSnapshot !== null
        && captureSheetSnapshot() !== sheetInitialSnapshot;
    }

    function confirmDiscardSheetChanges() {
      if (!isSheetDirty()) return true;
      return window.confirm("작성 중인 내용이 있어요. 저장하지 않고 닫을까요?");
    }

    function updateEditRecordSummary(leave = null) {
      const main = $("#editSummaryMain");
      const reason = $("#editSummaryReason");
      if (!main || !reason) return;

      if (!leave) {
        main.textContent = "";
        reason.textContent = "";
        return;
      }

      const type = getType(leave.type);
      const dateText = leave.startDate === (leave.endDate || leave.startDate)
        ? formatKoreanDate(leave.startDate, true)
        : `${formatKoreanDate(leave.startDate, true)} ~ ${formatKoreanDate(leave.endDate, true)}`;

      main.textContent = `${dateText} · ${type.icon} ${type.label}`;
      reason.textContent = `${isPlannedLeave(leave) ? "예정 쉼" : "확정 쉼"} · ${normalizeReasonLabel(leave.reason || "사유 없음")}`;
    }

    function applySheetMode(mode = "create") {
      const isEdit = mode === "edit";
      document.body.classList.toggle("editing-leave", isEdit);
      $("#sheetTitle").textContent = isEdit ? "휴가 수정" : "휴가 등록";
      $("#saveLeave").textContent = isEdit ? "수정 완료" : "등록 완료";
      $("#deleteForDate").textContent = isEdit ? "삭제하기" : "이 날짜 삭제";
    }

    function showSheet() {
      closeDaySummary();
      const wasActive = $("#sheet").classList.contains("active");
      lastFocusedElement = document.activeElement;
      $("#overlay").classList.add("active");
      $("#sheet").classList.add("active");
      activeDialog = $("#sheet");
      bindAllDatePickers();
      bindMemoField();
      updateLeavePreview();
      markSheetClean();

      if (!wasActive && !sheetHistoryPushed) {
        pushSheetHistoryState();
      }

      focusFirstField(activeDialog, "#startDate");
    }

    function resetSheetState(dateISO = toISO(today)) {
      editingLeaveId = null;
      draftLeaveId = generateStableId("leave");
      selectedDateISO = dateISO;
      selectedType = "annual";
      selectedStatus = "confirmed";
      selectedReason = reasonOptions[0];

      $("#startDate").value = dateISO;
      $("#endDate").value = dateISO;
      $("#customReason").value = "";
      $("#leaveMemo").value = "";
      $("#sheetSub").textContent = `${formatKoreanDate(dateISO, true)}의 쉼을 기록해요.`;
      updateEditRecordSummary(null);
      $("#deleteForDate").style.display = leavesForDate(dateISO).length ? "block" : "none";

      applySheetMode("create");
      renderStatusButtons();
      renderTypeButtons();
      renderReasonTags();
      updateCustomReasonMotion();
      updateLeavePreview();
    }

    function openSheet(dateISO = toISO(today)) {
      resetSheetState(dateISO);
      showSheet();
    }

    function openEditSheet(leaveId) {
      const leave = state.leaves.find(l => l.id === leaveId);
      if (!leave) {
        showToast("수정할 일정을 찾지 못했어요.");
        return;
      }

      editingLeaveId = leave.id;
      draftLeaveId = null;
      selectedDateISO = leave.startDate;
      selectedType = leave.type || "annual";
      selectedStatus = normalizeLeaveStatus(leave.status);

      const reason = leave.reason || reasonOptions[0];
      const isPresetReason = reasonOptions.includes(reason);
      selectedReason = isPresetReason ? reason : "직접 입력";

      $("#startDate").value = leave.startDate;
      $("#endDate").value = leave.endDate || leave.startDate;
      $("#customReason").value = isPresetReason ? "" : reason;
      $("#leaveMemo").value = leave.memo ?? "";
      $("#sheetSub").textContent = `${formatKoreanDate(leave.startDate, true)}의 쉼을 수정해요.`;
      updateEditRecordSummary(leave);
      $("#deleteForDate").style.display = "block";

      applySheetMode("edit");
      renderStatusButtons();
      renderTypeButtons();
      renderReasonTags();
      updateCustomReasonMotion();
      updateLeavePreview();
      showSheet();

      setTimeout(() => {
        const memoField = document.getElementById("leaveMemo");
        if (memoField) memoField.value = leave.memo ?? "";
      }, 0);
    }

    function closeSheet(options = {}) {
      const settings = typeof options === "object" && options !== null ? options : {};
      const force = Boolean(settings.force);
      const fromHistory = Boolean(settings.fromHistory);
      const sheet = $("#sheet");
      if (!sheet?.classList.contains("active")) return true;

      if (!force && !confirmDiscardSheetChanges()) {
        if (fromHistory && !sheetHistoryPushed) {
          pushSheetHistoryState();
        }
        return false;
      }

      sheet.classList.remove("active");
      sheetInitialSnapshot = null;
      draftLeaveId = null;

      if (!$("#settingsModal").classList.contains("active")) {
        $("#overlay").classList.remove("active");
        activeDialog = null;
      }

      if (sheetHistoryPushed && !fromHistory) {
        sheetHistoryPushed = false;
        history.back();
      } else if (fromHistory) {
        sheetHistoryPushed = false;
      }

      if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
        lastFocusedElement.focus();
      }
      return true;
    }

    function cancelEdit() {
      const closed = closeSheet();
      if (!closed) return;
      editingLeaveId = null;
      document.body.classList.remove("editing-leave");
    }

    function openSettings() {
      renderDashboard();
      lastFocusedElement = document.activeElement;
      $("#overlay").classList.add("active");
      $("#settingsModal").classList.add("active");
      activeDialog = $("#settingsModal");
      focusFirstField(activeDialog, "#totalInput");
    }

    function closeSettingsModal() {
      $("#settingsModal").classList.remove("active");
      if (!$("#sheet").classList.contains("active")) {
        $("#overlay").classList.remove("active");
        activeDialog = null;
      }
      if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
        lastFocusedElement.focus();
      }
    }

    function hideToast() {
      const toast = $("#toast");
      const action = $("#toastAction");
      clearTimeout(showToast.timer);
      if (!toast) return;
      toast.classList.remove("active", "has-action");
      if (action) {
        action.hidden = true;
        action.onclick = null;
        action.disabled = false;
      }
    }

    function showToast(text, type = "auto", options = {}) {
      const toast = $("#toast");
      const messageEl = $("#toastMessage");
      const action = $("#toastAction");
      if (!toast || !messageEl || !action) return;

      const message = String(text || "");
      let resolvedType = type;

      if (resolvedType === "auto") {
        if (/오류|못했|찾지 못|필요합니다|선택해 주세요|입력해 주세요|확인해 주세요|올바른/.test(message)) {
          resolvedType = "error";
        } else if (/없어요|관리자 계정|오프라인/.test(message)) {
          resolvedType = "info";
        } else {
          resolvedType = "success";
        }
      }

      messageEl.textContent = message;
      toast.classList.remove("success", "info", "error", "active", "has-action");
      action.hidden = true;
      action.onclick = null;
      action.disabled = false;

      if (options.actionLabel && typeof options.onAction === "function") {
        action.textContent = options.actionLabel;
        action.hidden = false;
        toast.classList.add("has-action");
        action.onclick = async () => {
          action.disabled = true;
          hideToast();
          try {
            await options.onAction();
          } catch (error) {
            console.error(error);
          }
        };
      }

      void toast.offsetWidth;
      toast.classList.add(resolvedType, "active");

      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(hideToast, Number(options.duration || 2600));
    }

    function formatLeaveDeleteDetail(leaves) {
      if (!leaves.length) return "선택한 기록";
      if (leaves.length > 1) {
        const dates = leaves.map(leave => leave.startDate).sort();
        const first = formatKoreanDate(dates[0], true);
        const last = formatKoreanDate(dates[dates.length - 1], true);
        return `${first}${first === last ? "" : ` ~ ${last}`} · 총 ${leaves.length}건`;
      }

      const leave = leaves[0];
      const type = getType(leave.type);
      const dateText = leave.startDate === (leave.endDate || leave.startDate)
        ? formatKoreanDate(leave.startDate, true)
        : `${formatKoreanDate(leave.startDate, true)} ~ ${formatKoreanDate(leave.endDate, true)}`;
      return `${dateText} · ${type.icon} ${type.label} · ${normalizeReasonLabel(leave.reason || "사유 없음")}`;
    }

    function openDeleteConfirm({ ids, title, message, successMessage, closeSheetAfter = false, afterDelete = null }) {
      const uniqueIds = [...new Set((ids || []).filter(Boolean))];
      const leaves = state.leaves.filter(leave => uniqueIds.includes(leave.id));
      if (!leaves.length) {
        showToast("삭제할 기록을 찾지 못했어요.", "error");
        return;
      }

      pendingDeleteRequest = {
        ids: uniqueIds,
        successMessage: successMessage || (uniqueIds.length > 1 ? "선택한 기록을 삭제했어요." : "일정을 삭제했어요."),
        closeSheetAfter,
        afterDelete
      };

      deleteDialogPrevious = activeDialog;
      deleteDialogFocus = document.activeElement;
      $("#deleteConfirmTitle").textContent = title || (uniqueIds.length > 1 ? `${uniqueIds.length}개의 기록을 삭제할까요?` : "이 기록을 삭제할까요?");
      $("#deleteConfirmMessage").textContent = message || "삭제 후 8초 동안 되돌릴 수 있어요.";
      $("#deleteConfirmDetail").textContent = formatLeaveDeleteDetail(leaves);
      $("#confirmDelete").textContent = uniqueIds.length > 1 ? `${uniqueIds.length}건 삭제` : "삭제하기";
      $("#confirmDelete").disabled = false;

      $("#overlay").classList.add("active");
      $("#deleteConfirmModal").classList.add("active");
      activeDialog = $("#deleteConfirmModal");
      focusFirstField(activeDialog, "#cancelDeleteConfirm");
    }

    function closeDeleteConfirm(restoreFocus = true) {
      $("#deleteConfirmModal")?.classList.remove("active");
      pendingDeleteRequest = null;

      const previousStillOpen = deleteDialogPrevious?.classList?.contains("active");
      activeDialog = previousStillOpen ? deleteDialogPrevious : null;

      const anotherDialogOpen = $("#sheet").classList.contains("active")
        || $("#settingsModal").classList.contains("active")
        || $("#holidayModal")?.classList.contains("active");
      if (!anotherDialogOpen) $("#overlay").classList.remove("active");

      if (restoreFocus && deleteDialogFocus && typeof deleteDialogFocus.focus === "function") {
        deleteDialogFocus.focus();
      }
      deleteDialogPrevious = null;
      deleteDialogFocus = null;
    }

    async function confirmPendingDelete() {
      const request = pendingDeleteRequest;
      if (!request) return;

      const button = $("#confirmDelete");
      button.disabled = true;
      button.textContent = "삭제 중…";

      try {
        const deletedLeaves = state.leaves
          .filter(leave => request.ids.includes(leave.id))
          .map(leave => ({ ...leave }));

        await runStorageAction(
          () => request.ids.length === 1
            ? storage.deleteLeave(request.ids[0])
            : storage.deleteLeavesByIds(request.ids),
          "휴가 삭제 중 오류가 발생했어요."
        );

        state.leaves = state.leaves.filter(leave => !request.ids.includes(leave.id));
        const afterDelete = request.afterDelete;
        const closeSheetAfter = request.closeSheetAfter;
        const successMessage = request.successMessage;

        closeDeleteConfirm(false);

        if (closeSheetAfter) {
          closeSheet({ force: true });
          editingLeaveId = null;
          document.body.classList.remove("editing-leave");
        }

        renderAll();
        if (typeof afterDelete === "function") afterDelete();

        const undoToken = ++pendingUndoToken;
        showToast(successMessage, "success", {
          actionLabel: "되돌리기",
          duration: 8000,
          onAction: async () => {
            if (undoToken !== pendingUndoToken || !deletedLeaves.length) return;
            await runStorageAction(
              () => storage.restoreLeaves(deletedLeaves),
              "삭제한 기록을 복구하지 못했어요."
            );
            state.leaves = [
              ...state.leaves.filter(item => !deletedLeaves.some(deleted => deleted.id === item.id)),
              ...deletedLeaves
            ].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
            renderAll();
            showToast("삭제한 일정을 되돌렸어요.", "success");
          }
        });
      } catch (error) {
        button.disabled = false;
        button.textContent = request.ids.length > 1 ? `${request.ids.length}건 삭제` : "삭제하기";
      }
    }

    async function saveLeave() {
      const startDate = $("#startDate").value;
      const endDate = $("#endDate").value || startDate;
      if (!startDate) {
        showToast("날짜를 선택해 주세요.", "error");
        return;
      }

      let reason = selectedReason;
      if (selectedReason.includes("직접 입력")) {
        reason = $("#customReason").value.trim() || "직접 입력";
      }

      const [start, end] = clampDateRange(startDate, endDate);
      const saveTargetId = editingLeaveId;
      const existing = saveTargetId
        ? state.leaves.find(l => l.id === saveTargetId)
        : null;

      reason = normalizeReasonLabel(sanitizePlainText(reason, 120));
      const memo = sanitizePlainText($("#leaveMemo").value, 200);

      const payload = {
        id: saveTargetId || draftLeaveId || (draftLeaveId = generateStableId("leave")),
        startDate: toISO(start),
        endDate: toISO(end),
        type: selectedType,
        reason,
        memo,
        status: selectedStatus,
        createdAt: existing?.createdAt || new Date().toISOString()
      };

      if (hasOverlappingLeave(payload)) {
        const ok = confirm("선택한 날짜에 이미 등록된 쉼이 있어요. 그래도 저장할까요?");
        if (!ok) return;
      }

      const saveButton = $("#saveLeave");
      saveButton.disabled = true;
      saveButton.textContent = existing ? "수정 중..." : "등록 중...";

      try {
        const savedLeaveFromDb = await runStorageAction(
          () => saveTargetId ? storage.updateLeave(payload) : storage.createLeave(payload),
          "휴가 저장 중 오류가 발생했어요. 잠시 후 다시 시도해 주세요."
        );

        const savedLeave = {
          ...payload,
          ...(savedLeaveFromDb || {}),
          memo: savedLeaveFromDb?.memo ?? payload.memo ?? ""
        };

        // 서버 저장이 끝난 즉시 현재 화면 상태를 교체합니다.
        // push에만 의존하지 않아 중복 클릭이나 기존 id 충돌에도 안정적으로 반영됩니다.
        state.leaves = [
          ...state.leaves.filter(leave => leave.id !== savedLeave.id),
          savedLeave
        ].sort((a, b) => {
          const dateCompare = String(a.startDate).localeCompare(String(b.startDate));
          if (dateCompare !== 0) return dateCompare;
          return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
        });

        // 화면 렌더링보다 먼저 창을 닫아, 이후 부가 렌더링에서 문제가 생겨도
        // 저장 완료 동작이 사용자에게 확실히 전달되도록 합니다.
        closeSheet({ force: true });
        editingLeaveId = null;
        document.body.classList.remove("editing-leave");

        try {
          renderAll();
        } catch (renderError) {
          console.error("저장 후 화면 갱신 오류", renderError);
          // 핵심 영역을 한 번 더 갱신해 새로고침 없이 등록 결과를 보여줍니다.
          renderDashboard();
          renderCalendar();
          renderUpcoming();
        }

        warnIfMemoColumnMissing();
        showToast(existing ? "일정을 수정했어요." : "쉼을 등록했어요.", "success");
      } catch (error) {
        // 서버 저장 자체가 실패한 경우에만 입력창을 유지합니다.
      } finally {
        saveButton.disabled = false;
        saveButton.textContent = saveTargetId ? "수정 완료" : "등록 완료";
      }
    }

    function deleteLeavesForCurrentRange() {
      if (editingLeaveId) {
        const leave = state.leaves.find(item => item.id === editingLeaveId);
        if (!leave) {
          showToast("삭제할 기록을 찾지 못했어요.", "error");
          return;
        }

        openDeleteConfirm({
          ids: [editingLeaveId],
          title: "수정 중인 기록을 삭제할까요?",
          message: "삭제하면 캘린더와 리포트에서도 바로 사라져요.",
          successMessage: "일정을 삭제했어요.",
          closeSheetAfter: true
        });
        return;
      }

      const startDate = $("#startDate").value;
      const endDate = $("#endDate").value || startDate;
      const [start, end] = clampDateRange(startDate, endDate);

      const targets = state.leaves.filter(leave => {
        const [leaveStart, leaveEnd] = clampDateRange(leave.startDate, leave.endDate);
        return !(leaveEnd < start || leaveStart > end);
      });

      if (!targets.length) {
        showToast("삭제할 기록이 없어요.", "info");
        return;
      }

      openDeleteConfirm({
        ids: targets.map(leave => leave.id),
        title: targets.length > 1 ? `${targets.length}개의 기록을 모두 삭제할까요?` : "이 날짜의 기록을 삭제할까요?",
        message: targets.length > 1
          ? "선택한 날짜 범위와 겹치는 기록이 모두 삭제돼요."
          : "삭제 후 잠시 동안 되돌릴 수 있어요.",
        successMessage: targets.length > 1 ? `${targets.length}개의 기록을 삭제했어요.` : "선택한 날짜의 기록을 삭제했어요.",
        closeSheetAfter: true
      });
    }


    function syncMobileUpcomingPlacement() {
      // 모바일 다가오는 쉼은 별도 상단 카드에 렌더링합니다.
    }



    function getHolidayFilterYearValue() {
      const currentYear = today.getFullYear();
      if (selectedHolidayYearFilter === "current") return String(currentYear);
      if (selectedHolidayYearFilter === "next") return String(currentYear + 1);
      return "all";
    }

    function updateHolidayFilterLabels() {
      const currentYear = today.getFullYear();
      document.querySelectorAll("[data-holiday-year]").forEach(btn => {
        const key = btn.dataset.holidayYear;
        if (key === "current") btn.textContent = `${currentYear}년`;
        if (key === "next") btn.textContent = `${currentYear + 1}년`;
        btn.classList.toggle("active", selectedHolidayYearFilter === key);
      });
    }

    function setHolidayEditMode(date = null, name = "") {
      editingHolidayOriginalDate = date;
      const stateEl = $("#holidayEditState");
      const textEl = $("#holidayEditText");
      const saveBtn = $("#saveHoliday");
      if (!stateEl || !textEl || !saveBtn) return;

      stateEl.classList.toggle("editing", Boolean(date));

      if (date) {
        textEl.textContent = `수정 중: ${date} · ${name}`;
        saveBtn.textContent = "수정 완료";
      } else {
        textEl.textContent = "새 공휴일을 추가하는 중이에요.";
        saveBtn.textContent = "추가하기";
      }
    }

    function cancelHolidayEditMode() {
      editingHolidayOriginalDate = null;
      $("#holidayDateInput").value = toISO(today);
      $("#holidayNameInput").value = "";
      setHolidayEditMode(null);
    }

    function getExistingHolidayName(date) {
      const map = getHolidayMap();
      return map[date] || "";
    }

    function csvEscape(value) {
      const raw = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
      const safeText = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
      return `"${safeText.replace(/"/g, '""')}"`;
    }

    function exportLeavesCsv() {
      if (!state.leaves.length) {
        showToast("내보낼 연차 기록이 없어요.");
        return;
      }

      const headers = ["시작일", "종료일", "상태", "휴가종류", "사유", "메모", "차감일수", "등록일"];
      const rows = state.leaves
        .slice()
        .sort((a, b) => a.startDate.localeCompare(b.startDate))
        .map(leave => {
          const type = getType(leave.type);
          return [
            leave.startDate,
            leave.endDate || leave.startDate,
            isPlannedLeave(leave) ? "예정" : "확정",
            type.label,
            leave.reason || "",
            leave.memo || "",
            calcLeaveAmount(leave, { includePlanned: true }),
            leave.createdAt || ""
          ];
        });

      const csv = [
        headers.map(csvEscape).join(","),
        ...rows.map(row => row.map(csvEscape).join(","))
      ].join("\n");

      const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `쉼표_연차기록_${toISO(today)}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showToast("CSV 파일을 내려받았어요.");
    }

    function hasOverlappingLeave(payload) {
      const [start, end] = clampDateRange(payload.startDate, payload.endDate);
      return state.leaves.some(leave => {
        if (editingLeaveId && leave.id === editingLeaveId) return false;
        const [leaveStart, leaveEnd] = clampDateRange(leave.startDate, leave.endDate);
        return !(leaveEnd < start || leaveStart > end);
      });
    }


    async function renderHolidayManager() {
      const list = $("#holidayAdminList");
      if (!list) return;

      updateHolidayFilterLabels();
      list.innerHTML = `<div class="holiday-empty">공휴일 데이터를 불러오는 중이에요.</div>`;

      try {
        const rows = await listHolidaysFromSupabase();
        const filterYear = getHolidayFilterYearValue();
        const filteredRows = filterYear === "all"
          ? rows
          : rows.filter(row => String(row.date).startsWith(`${filterYear}-`));

        if (!filteredRows.length) {
          list.innerHTML = `<div class="holiday-empty">해당 연도에 등록된 공휴일이 없어요.</div>`;
          return;
        }

        list.innerHTML = filteredRows.map(row => {
          const safeDate = escapeHTML(row.date);
          const safeName = escapeHTML(row.name);
          return `
            <div class="holiday-row">
              <span class="holiday-row-date">${safeDate}</span>
              <span class="holiday-row-name">${safeName}${row.is_holiday ? "" : " · 비활성"}</span>
              ${isHolidayAdmin() ? `
                <span class="holiday-row-actions">
                  <button class="holiday-edit-btn" data-date="${escapeAttr(row.date)}" data-name="${escapeAttr(row.name)}" type="button" aria-label="공휴일 수정">✎</button>
                  <button class="holiday-delete-btn" data-date="${escapeAttr(row.date)}" type="button" aria-label="공휴일 삭제">×</button>
                </span>
              ` : ""}
            </div>
          `;
        }).join("");

        list.querySelectorAll(".holiday-edit-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            $("#holidayDateInput").value = btn.dataset.date;
            $("#holidayNameInput").value = btn.dataset.name;
            setHolidayEditMode(btn.dataset.date, btn.dataset.name);
            $("#holidayNameInput").focus();
          });
        });

        list.querySelectorAll(".holiday-delete-btn").forEach(btn => {
          btn.addEventListener("click", async () => {
            if (!isHolidayAdmin()) {
              showToast("공휴일 관리는 관리자 계정에서만 가능해요.");
              return;
            }

            const date = btn.dataset.date;
            if (!confirm(`${date} 공휴일을 삭제할까요?`)) return;

            await runStorageAction(
              () => deleteHolidayFromSupabase(date),
              "공휴일 삭제 중 오류가 발생했어요. Supabase 정책을 확인해 주세요."
            );

            if (editingHolidayOriginalDate === date) cancelHolidayEditMode();
            await loadHolidaysFromSupabase();
            renderCalendar();
            renderPlannedLeaves();
            await renderHolidayManager();
            showToast("공휴일을 삭제했어요.");
          });
        });
      } catch (error) {
        console.error(error);
        list.innerHTML = `<div class="holiday-empty">공휴일 목록을 불러오지 못했어요.<br>Supabase holidays 테이블 권한을 확인해 주세요.</div>`;
      }
    }

    function openHolidayManager() {
      if (!isHolidayAdmin()) {
        showToast("공휴일 관리는 관리자 계정에서만 가능해요.");
        return;
      }

      closeSettingsModal();
      lastFocusedElement = document.activeElement;
      $("#overlay").classList.add("active");
      $("#holidayModal").classList.add("active");
      activeDialog = $("#holidayModal");
      $("#holidayDateInput").value = toISO(today);
      $("#holidayNameInput").value = "";
      setHolidayEditMode(null);
      updateHolidayFilterLabels();
      bindAllDatePickers();
      renderHolidayManager();
      focusFirstField(activeDialog, "#holidayDateInput");
    }

    function closeHolidayManager() {
      $("#holidayModal").classList.remove("active");
      if (!$("#sheet").classList.contains("active") && !$("#settingsModal").classList.contains("active")) {
        $("#overlay").classList.remove("active");
        activeDialog = null;
      }
      if (lastFocusedElement && typeof lastFocusedElement.focus === "function") {
        lastFocusedElement.focus();
      }
    }

    async function saveHolidayFromForm() {
      if (!isHolidayAdmin()) {
        showToast("공휴일 관리는 관리자 계정에서만 가능해요.");
        return;
      }

      const date = $("#holidayDateInput").value;
      const name = sanitizePlainText($("#holidayNameInput").value, 80);

      if (!date || !isValidISODate(date)) {
        showToast("올바른 공휴일 날짜를 선택해 주세요.", "error");
        return;
      }

      if (!name) {
        showToast("공휴일 이름을 입력해 주세요.");
        return;
      }

      const existingName = getExistingHolidayName(date);
      const isEditing = Boolean(editingHolidayOriginalDate);
      const isChangingDate = isEditing && editingHolidayOriginalDate !== date;

      if (existingName && (!isEditing || isChangingDate)) {
        const ok = confirm(`${date}에는 이미 "${existingName}" 공휴일이 있어요. 이 이름을 "${name}"으로 덮어쓸까요?`);
        if (!ok) return;
      }

      await runStorageAction(
        () => upsertHolidayToSupabase(date, name),
        "공휴일 저장 중 오류가 발생했어요. Supabase 정책을 확인해 주세요."
      );

      if (isChangingDate) {
        await runStorageAction(
          () => deleteHolidayFromSupabase(editingHolidayOriginalDate),
          "기존 공휴일 삭제 중 오류가 발생했어요."
        );
      }

      await loadHolidaysFromSupabase();
      renderCalendar();
      renderPlannedLeaves();
      await renderHolidayManager();
      $("#holidayNameInput").value = "";
      setHolidayEditMode(null);
      showToast(isEditing ? "공휴일을 수정했어요." : "공휴일을 저장했어요.");
    }


    function renderAll() {
      renderDashboard();
      renderCalendar();
      renderUpcoming();
      renderPlannedLeaves();
      syncMobilePanels();
      if (currentView === "report") renderReport();
      $("#todayChip").textContent = `${today.getFullYear()}년 ${today.getMonth() + 1}월 ${today.getDate()}일 ${dayLabel[today.getDay()]}요일`;
      if (mobileSummaryDateISO && !leavesForDate(mobileSummaryDateISO).length) {
        closeDaySummary();
      }
    }


    function setAuthView(isLoggedIn) {
      document.body.classList.toggle("auth-mode", !isLoggedIn);
      if (isLoggedIn && currentUser) {
        $("#userEmail").textContent = currentUser.email || "Google 계정";
      }
      syncAdminUI();
    }


    async function loadUserWorkspace({ showSuccessToast = false } = {}) {
      if (!currentUser) return;

      const targetUserId = currentUser.id;
      if (workspaceLoadPromise && workspaceLoadUserId === targetUserId) {
        return workspaceLoadPromise;
      }

      workspaceLoadUserId = targetUserId;
      workspaceLoadPromise = (async () => {
        setAuthView(true);
        setSyncStatus("syncing", "데이터 불러오는 중…");

        try {
          const saved = await storage.load();

          // 계정이 바뀌는 도중 이전 요청이 끝난 경우, 이전 계정 데이터를 화면에 덮어쓰지 않습니다.
          if (currentUser?.id !== targetUserId) return;

          if (saved && typeof saved === "object") {
            state = {
              settings: Object.assign({ totalLeave: 15 }, saved.settings || {}),
              leaves: Array.isArray(saved.leaves) ? saved.leaves : []
            };
          }
          initializedUserId = targetUserId;
          setSyncStatus(navigator.onLine ? "idle" : "offline", navigator.onLine ? "동기화됨" : "오프라인 · 저장되지 않음");
          renderTypeButtons();
          renderReasonTags();
          renderAll();
          setViewMode("calendar");
          if (showSuccessToast) showToast("계정 데이터를 불러왔어요.", "success");
        } catch (error) {
          console.error(error);
          if (currentUser?.id !== targetUserId) return;
          setSyncStatus(navigator.onLine ? "error" : "offline", navigator.onLine ? "동기화 실패 · 확인하기" : "오프라인 · 저장되지 않음");
          showToast("데이터를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.", "error");
        }
      })();

      try {
        return await workspaceLoadPromise;
      } finally {
        if (workspaceLoadUserId === targetUserId) {
          workspaceLoadPromise = null;
          workspaceLoadUserId = null;
        }
      }
    }


    function clearSignedOutState() {
      currentUser = null;
      initializedUserId = null;
      state = { settings: { totalLeave: 15 }, leaves: [] };
      closeDaySummary();
      if ($("#sheet")?.classList.contains("active")) closeSheet({ force: true });
      syncAdminUI();
      setAuthView(false);
    }

    function bindAuthStateListener() {
      if (authListenerBound) return;
      authListenerBound = true;

      supabaseClient.auth.onAuthStateChange((event, session) => {
        window.setTimeout(async () => {
          const nextUser = session?.user || null;

          if (!nextUser) {
            if (event === "SIGNED_OUT" || currentUser) clearSignedOutState();
            return;
          }

          const userChanged = currentUser?.id !== nextUser.id;
          currentUser = nextUser;
          setAuthView(true);
          syncAdminUI();

          if (userChanged || initializedUserId !== nextUser.id) {
            await loadUserWorkspace({ showSuccessToast: event === "SIGNED_IN" });
          } else if (event === "USER_UPDATED" || event === "TOKEN_REFRESHED") {
            $("#userEmail").textContent = currentUser.email || "Google 계정";
          }
        }, 0);
      });
    }

    function bindAllDatePickers() {
      document.querySelectorAll('input[type="date"]').forEach(input => {
        input.readOnly = false;
        input.disabled = false;
      });
    }

    function bindMemoField() {
      const memo = document.getElementById("leaveMemo");
      if (!memo || memo.dataset.memoBound === "true") return;

      memo.dataset.memoBound = "true";
      memo.readOnly = false;
      memo.disabled = false;

      memo.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
      });

      memo.addEventListener("click", (event) => {
        event.stopPropagation();
        memo.focus();
      });

      memo.addEventListener("touchstart", (event) => {
        event.stopPropagation();
      }, { passive: true });

      memo.addEventListener("input", updateLeavePreview);
    }

    function bindAuthEvents() {
      const googleBtn = $("#googleLogin");
      if (googleBtn) {
        googleBtn.addEventListener("click", async () => {
          googleBtn.disabled = true;
          googleBtn.querySelector("strong").textContent = "Google 로그인으로 이동 중...";
          const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: "google",
            options: {
              redirectTo: `${window.location.origin}${window.location.pathname}`
            }
          });

          if (error) {
            console.error(error);
            googleBtn.disabled = false;
            googleBtn.querySelector("strong").textContent = "Google로 시작하기";
            alert("Google 로그인 연결에 실패했어요. 잠시 후 다시 시도해 주세요.");
          }
        });
      }

      const logoutBtn = $("#logoutBtn");
      if (logoutBtn) {
        logoutBtn.addEventListener("click", async () => {
          logoutBtn.disabled = true;
          const originalText = logoutBtn.textContent;
          logoutBtn.textContent = "로그아웃 중…";

          const { error } = await supabaseClient.auth.signOut();
          if (error) {
            console.error(error);
            logoutBtn.disabled = false;
            logoutBtn.textContent = originalText;
            showToast("로그아웃하지 못했어요. 연결 상태를 확인해 주세요.", "error");
            return;
          }

          currentUser = null;
          initializedUserId = null;
          state = { settings: { totalLeave: 15 }, leaves: [] };
          syncAdminUI();
          setAuthView(false);
          logoutBtn.disabled = false;
          logoutBtn.textContent = originalText;
        });
      }
    }

    function bindAppEventsOnce() {
      if (appEventsBound) return;
      appEventsBound = true;
      $("#prevMonth").addEventListener("click", () => {
        viewDate.setMonth(viewDate.getMonth() - 1);
        renderCalendar();
      });

      $("#nextMonth").addEventListener("click", () => {
        viewDate.setMonth(viewDate.getMonth() + 1);
        renderCalendar();
      });

      $("#goToday").addEventListener("click", () => {
        viewDate = new Date(today.getFullYear(), today.getMonth(), 1);
        renderCalendar();
      });

      $("#calendarTab").addEventListener("click", () => setViewMode("calendar"));
      $("#reportTab").addEventListener("click", () => setViewMode("report"));
      $("#backToCalendar").addEventListener("click", () => setViewMode("calendar"));

      $("#donutWrap").addEventListener("click", () => {
        $("#donutWrap").classList.toggle("show-tooltip");
      });

      $("#fab").addEventListener("click", () => openSheet(toISO(today)));
      $("#closeSheet").addEventListener("click", () => closeSheet());
      $("#toggleMiniPanel")?.addEventListener("click", () => {
        const panel = $("#miniPanel");
        setMiniPanelExpanded(panel.classList.contains("mobile-collapsed"));
      });
      $("#toggleRecommendCard")?.addEventListener("click", () => {
        const card = $("#recommendCard");
        if (card) setRecommendationExpanded(card.classList.contains("mobile-collapsed"));
      });
      $("#openPlannedLeave")?.addEventListener("click", () => {
        openSheet(toISO(today));
        selectedStatus = "planned";
        renderStatusButtons();
        updateLeavePreview();
      });
      $("#closeDaySummary")?.addEventListener("click", closeDaySummary);
      $("#addLeaveFromSummary")?.addEventListener("click", () => {
        const targetDate = mobileSummaryDateISO || toISO(today);
        closeDaySummary();
        openSheet(targetDate);
      });
      $("#cancelEdit").addEventListener("click", cancelEdit);
      $("#cancelDeleteConfirm").addEventListener("click", () => closeDeleteConfirm());
      $("#confirmDelete").addEventListener("click", confirmPendingDelete);
      $("#syncStatus")?.addEventListener("click", () => refreshFromCloud(true));
      $("#saveLeave").addEventListener("click", saveLeave);
      $("#deleteForDate").addEventListener("click", deleteLeavesForCurrentRange);
      $("#startDate").addEventListener("input", updateLeavePreview);
      $("#endDate").addEventListener("input", updateLeavePreview);
      document.addEventListener("keydown", handleDialogKeydown);

      $("#openSettings").addEventListener("click", openSettings);
      $("#closeSettings").addEventListener("click", closeSettingsModal);
      $("#openHolidayManager").addEventListener("click", openHolidayManager);
      $("#closeHolidayModal").addEventListener("click", closeHolidayManager);
      $("#saveHoliday").addEventListener("click", saveHolidayFromForm);
      $("#refreshHolidays").addEventListener("click", renderHolidayManager);
      $("#cancelHolidayEdit").addEventListener("click", cancelHolidayEditMode);
      $("#exportLeavesCsv").addEventListener("click", exportLeavesCsv);
      document.querySelectorAll("[data-holiday-year]").forEach(btn => {
        btn.addEventListener("click", () => {
          selectedHolidayYearFilter = btn.dataset.holidayYear;
          renderHolidayManager();
        });
      });

      $("#saveSettings").addEventListener("click", async () => {
        const value = Number($("#totalInput").value);
        if (Number.isNaN(value) || value < 0) {
          showToast("올바른 연차 개수를 입력해 주세요.");
          return;
        }
        const nextTotalLeave = Math.round(value * 100) / 100;
        try {
          await runStorageAction(
            () => storage.saveSettings(nextTotalLeave),
            "연차 설정 저장 중 오류가 발생했어요."
          );
          state.settings.totalLeave = nextTotalLeave;
          closeSettingsModal();
          renderAll();
          showToast("연차 설정을 저장했어요.");
        } catch (error) {
          // 입력창을 유지해 다시 저장할 수 있게 합니다.
        }
      });

      $("#overlay").addEventListener("click", () => {
        if ($("#deleteConfirmModal").classList.contains("active")) {
          closeDeleteConfirm();
          return;
        }
        if ($("#sheet").classList.contains("active")) {
          const closed = closeSheet();
          if (!closed) return;
        }
        closeSettingsModal();
        closeHolidayManager();
      });

      $("#prevRec")?.addEventListener("click", () => {
        if (!recommendations.length) return;
        recIndex = (recIndex - 1 + recommendations.length) % recommendations.length;
        renderRecommendation();
      });

      $("#nextRec")?.addEventListener("click", () => {
        if (!recommendations.length) return;
        recIndex = (recIndex + 1) % recommendations.length;
        renderRecommendation();
      });

      setInterval(() => {
        if (!recommendations.length) return;
        recIndex = (recIndex + 1) % recommendations.length;
        renderRecommendation();
      }, 9000);
    }

    async function init() {
      bindAuthEvents();
      bindAuthStateListener();
      bindAppEventsOnce();
      bindAllDatePickers();
      bindMemoField();
      updateOnlineStatus();

      const { data: sessionData, error: sessionError } = await supabaseClient.auth.getSession();
      if (sessionError) {
        console.error(sessionError);
        setAuthView(false);
        showToast("로그인 상태를 확인하지 못했어요.", "error");
        return;
      }

      currentUser = sessionData.session?.user || null;
      syncAdminUI();

      if (!currentUser) {
        setAuthView(false);
        return;
      }

      if (initializedUserId !== currentUser.id) {
        await loadUserWorkspace();
      }
    }



    function updateAppViewportHeight() {
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      document.documentElement.style.setProperty(
        "--app-viewport-height",
        `${Math.round(viewportHeight)}px`
      );
    }

    updateAppViewportHeight();
    window.visualViewport?.addEventListener("resize", updateAppViewportHeight);
    window.visualViewport?.addEventListener("scroll", updateAppViewportHeight);
    window.addEventListener("orientationchange", updateAppViewportHeight);

    window.addEventListener("resize", () => {
      syncMobileUpcomingPlacement();
      syncMobilePanels();
      if (!isMobileViewport()) closeDaySummary();
      renderCalendar();
    });

    window.addEventListener("online", () => updateOnlineStatus({ announce: true }));
    window.addEventListener("offline", () => updateOnlineStatus({ announce: true }));

    window.addEventListener("beforeunload", (event) => {
      if (!isSheetDirty()) return;
      event.preventDefault();
      event.returnValue = "";
    });

    window.addEventListener("popstate", () => {
      if (!$("#sheet")?.classList.contains("active")) return;
      sheetHistoryPushed = false;
      closeSheet({ fromHistory: true });
    });

    init();

    document.addEventListener("click", (event) => {
      const monthBar = event.target.closest(".month-bar-item[data-month]");
      if (monthBar && window.matchMedia("(max-width: 720px)").matches) {
        openMonthUsagePopup(monthBar.dataset.month, monthBar.dataset.amount, monthBar);
        return;
      }

      if (!event.target.closest("#monthUsagePopup")) {
        closeMonthUsagePopup();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMonthUsagePopup();
      }

      const monthBar = event.target.closest?.(".month-bar-item[data-month]");
      if (!monthBar) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openMonthUsagePopup(monthBar.dataset.month, monthBar.dataset.amount, monthBar);
      }
    });

    window.addEventListener("resize", closeMonthUsagePopup);
