/**
 * PurchaseSso.gs — 貨單核對（財務部門）自動登入貨單辨識系統（2026-10-24，docs/purchase-fin/spec.md §2）
 *
 *  1. purchaseSubForUser_：ssoTicket aud 'purchase' 的 sub（StaffClock.gs handleSsoTicket_ 呼叫）
 *  2. purchaseIdent_：sub → 身分＋現在還有沒有 platform.purchase（跟登入 session 同一套算法）
 *  3. svcPurchaseRedeem／svcPurchaseWho（憑 Script Property PURCHASE_SVC_KEY；貨單後端在同一台 Mac mini 呼叫）
 *
 * ⚠ ssoTicket／svcPurchaseRedeem／svcPurchaseWho 永遠不可列進 minikit app.json 的 readActions，
 *   也不可列進 platform/dryrun.js 的 READ_ACTIONS 服務動作（唯讀動作在鏡像／回退模式可能被重放＝券能用兩次）。
 */

var PURCHASE_PROP_SVC_KEY = 'PURCHASE_SVC_KEY';
var PURCHASE_AUD = 'purchase';
var PURCHASE_PERM = 'platform.purchase';
var PURCHASE_MSG = {
  UNAUTHORIZED: '服務金鑰錯誤',
  BAD_AUD: '不支援的系統',
  TICKET_INVALID: '入場券無效或已過期',
  BAD_INPUT: '格式錯誤',
  BUSY: '系統忙碌中，請稍後再試'
};

function purchaseKeyOk_(payload) {
  var want = PropertiesService.getScriptProperties().getProperty(PURCHASE_PROP_SVC_KEY);
  var got = payload && typeof payload.svc_key === 'string' ? payload.svc_key : '';
  return !!want && !!got && authSafeEqual_(got, want);
}

function purchaseSubOk_(sub) {
  return typeof sub === 'string' && (STORE_SUB_STAFF_RE.test(sub) || STORE_SUB_ADMIN_RE.test(sub));
}

/**
 * 登入的帳號 → sub。在職同仁（role staff、staff 列 active、編號相符）→ DZY 編號；
 * 非 staff 的系統帳號（admin 等）→ 'U:'+users.id；其他 → ''（呼叫端回 no_emp）。
 * 能不能進由 platform.purchase 決定，這裡只管「是誰」。
 */
function purchaseSubForUser_(user) {
  if (!user) return '';
  if (String(user.role) === 'staff') {
    var emp = String(user.username || '').toUpperCase();
    if (!STORE_SUB_STAFF_RE.test(emp)) return '';
    var hit = stfFindByUserId_(user.id);
    if (hit && stfStr_(hit.values[STF_COL.status]) === 'active' && stfNormEmp_(hit.values[STF_COL.emp_no]) === emp) return emp;
    return '';
  }
  var id = String(user.id || '');
  return STORE_SUB_ADMIN_RE.test('U:' + id) ? 'U:' + id : '';
}

/**
 * sub → {sub, active:false} 或 {sub, active:true, allowed, name, emp_no, token_after}。
 * allowed＝與登入 session 相同的 authStaffGate_＋authPermsAndScope_ 算出的權限含 platform.purchase（admin 的 * 也算）。
 */
function purchaseIdent_(sub) {
  sub = String(sub || '');
  var inactive = { sub: sub, active: false };
  var found = null;
  if (STORE_SUB_ADMIN_RE.test(sub)) {
    found = findUserById_(sub.slice(2));
    if (!found) return inactive;
    if (String(rowToUser_(found.values).role) === 'staff') return inactive;   // 同仁一律用 DZY 編號
  } else if (STORE_SUB_STAFF_RE.test(sub)) {
    var s = stfFindByEmp_(sub);
    if (!s || stfStr_(s.values[STF_COL.status]) !== 'active') return inactive;
    var uid = stfStr_(s.values[STF_COL.user_id]);
    if (!uid) return inactive;
    found = findUserById_(uid);
    if (!found) return inactive;
    var su = rowToUser_(found.values);
    if (String(su.role) !== 'staff' || String(su.username || '').toUpperCase() !== sub) return inactive;
  } else {
    return inactive;
  }
  if (!isActiveValue_(found.values[AUTH_USERS_COL.active])) return inactive;
  var user = rowToUser_(found.values);
  var gate = authStaffGate_(user);
  if (gate.block) return inactive;
  var pc = authPermsAndScope_(user, gate);
  return {
    sub: sub,
    active: true,
    allowed: hasPerm_(pc.perms, PURCHASE_PERM),
    name: String(user.name || ''),
    emp_no: STORE_SUB_STAFF_RE.test(sub) ? sub : '',
    token_after: Number(found.values[AUTH_USERS_COL.token_after]) || 0
  };
}

/** 貨單後端兌換入場券。LockService 包住 get＋remove：同一張券只有一次成功；先取出就作廢（安全優先）。 */
function handleSvcPurchaseRedeem_(payload) {
  if (!purchaseKeyOk_(payload)) return clkErr_('unauthorized', PURCHASE_MSG.UNAUTHORIZED);
  var aud = payload && typeof payload.aud === 'string' ? payload.aud : '';
  if (aud !== PURCHASE_AUD) return clkErr_('bad_aud', PURCHASE_MSG.BAD_AUD);
  var ticket = payload && typeof payload.ticket === 'string' ? payload.ticket : '';
  if (!STORE_TICKET_RE.test(ticket)) return clkErr_('ticket_invalid', PURCHASE_MSG.TICKET_INVALID);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(STORE_LOCK_WAIT_MS)) return clkErr_('busy', PURCHASE_MSG.BUSY);
  var raw;
  try {
    var cache = CacheService.getScriptCache(), key = SSO_CACHE_PREFIX + ticket;
    raw = cache.get(key);
    cache.remove(key);
  } finally {
    lock.releaseLock();
  }
  var rec = null;
  try { rec = raw ? JSON.parse(raw) : null; } catch (e) { rec = null; }
  if (!rec || rec.aud !== PURCHASE_AUD || !purchaseSubOk_(rec.sub)) return clkErr_('ticket_invalid', PURCHASE_MSG.TICKET_INVALID);
  return { ok: true, data: purchaseIdent_(rec.sub) };
}

/** 貨單後端重查身分（每 5 分鐘）：停用、離職、被收回 platform.purchase、登出全部裝置都在這裡被發現。 */
function handleSvcPurchaseWho_(payload) {
  if (!purchaseKeyOk_(payload)) return clkErr_('unauthorized', PURCHASE_MSG.UNAUTHORIZED);
  var sub = payload && typeof payload.sub === 'string' ? payload.sub : '';
  if (!purchaseSubOk_(sub)) return clkErr_('bad_input', PURCHASE_MSG.BAD_INPUT);
  return { ok: true, data: purchaseIdent_(sub) };
}
