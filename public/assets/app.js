const API_URL = "/api/gateway.json";
const $ = id => document.getElementById(id);
const countdownEl = $("countdown");
const qrBox = $("qrcode");

const state = { gateway: null, timer: null };

function initQR() {
    new QRCode(qrBox, { text: "unavailable", width: 220, height: 220 });
}

function updateUI() {
    const isReady = !!state.gateway;
    const sticon = $("statusIcon");
    const sttext = $("statusText");
    const link = state.gateway?.link || "N/A";
    const timerLabel = $("timerLabel");
    const btn = $("actionButton");

    $("config-link").textContent = link;

    if (isReady) {
        sticon.textContent = "🟢";
        sttext.textContent = "Active";
        qrBox.classList.add("active");
        timerLabel.textContent = "Expires in:";
        countdownEl.style.color = "#60a5fa";
        btn.textContent = "Copy Config";
        btn.onclick = copyConfig;
        btn.disabled = false;
    } else {
        sticon.textContent = "🔴";
        sttext.textContent = "Unavailable";
        qrBox.classList.remove("active");
        timerLabel.textContent = "Status:";
        countdownEl.textContent = "--";
        countdownEl.style.color = "#94a3b8";
        btn.textContent = "Refresh";
        btn.onclick = () => location.reload();
        btn.disabled = false;
    }
}

async function loadGateway() {
    try {
        const res = await fetch(API_URL, { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (data.expire_timestamp * 1000 <= Date.now()) throw new Error();
        if (data.link) { data.link = atob(data.link); }
        state.gateway = data;
        qrBox.innerHTML = "";
        new QRCode(qrBox, { text: data.link, width: 220, height: 220 });
        startTimer(data.expire_timestamp);
        updateUI();
        toast("✅ Gateway ready");
        return true;
    } catch {
        state.gateway = null;
        clearInterval(state.timer);
        state.timer = null;
        updateUI();
        toast("⚠️ No active gateway");
        return false;
    }
}

function startTimer(expireTimestamp) {
    clearInterval(state.timer);
    const expire = expireTimestamp * 1000;
    state.timer = setInterval(() => {
        const remain = expire - Date.now();
        if (remain <= 0) {
            clearInterval(state.timer);
            state.timer = null;
            state.gateway = null;
            updateUI();
            toast("⏳ Gateway expired");
            return;
        }
        const m = Math.floor(remain / 60000);
        const s = Math.floor((remain % 60000) / 1000);
        countdownEl.textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    }, 1000);
}

async function copyConfig() {
    if (!state.gateway) return;
    try {
        await navigator.clipboard.writeText(state.gateway.link);
        toast("✅ Copied");
    } catch {
        toast("❌ Copy failed");
    }
}

function toast(msg) {
    const old = document.querySelector(".toast");
    if (old) old.remove();
    const div = document.createElement("div");
    div.className = "toast";
    div.textContent = msg;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), 3000);
}

function cleanup() {
    clearInterval(state.timer);
}

initQR();
loadGateway();
window.addEventListener("beforeunload", cleanup);