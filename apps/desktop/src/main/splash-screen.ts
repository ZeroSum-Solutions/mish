// Mark generated with HiggsField Recraft V4.1. Master: assets/brand/mishh-mashh-master.svg.
export function createSplashHtml(start: { step: number; total: number; label: string }): string {
  const initialPct = Math.max(0, Math.min(100, Math.round((start.step / start.total) * 100)));
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Mishh Mashh</title>
    <style>
      html,
      body {
        background: #F1EFEA;
        height: 100%;
        margin: 0;
        overflow: hidden;
      }
      body {
        align-items: center;
        display: flex;
        justify-content: center;
      }
      .brand { text-align: center; color: #151719; font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; }
      .brand svg { width: 176px; height: 110px; display: block; margin: 0 auto 22px; }
      .brand-name { font-size: 44px; font-weight: 750; letter-spacing: -0.055em; }
      .brand-note { margin-top: 16px; font-size: 14px; letter-spacing: 0.02em; color: #676B66; }
      @media (prefers-reduced-motion: reduce) { .boot-dots .dot { animation: none; } .boot-stage, .boot-progress-fill { transition: none; } }
      .boot-stage {
        bottom: 56px;
        color: #7a838a;
        font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        font-size: 13px;
        left: 0;
        letter-spacing: 0.02em;
        position: fixed;
        right: 0;
        text-align: center;
        transition: opacity 200ms cubic-bezier(0.23, 1, 0.32, 1);
        user-select: none;
      }
      .boot-stage-swapping {
        opacity: 0;
        transition-duration: 140ms;
      }
      .boot-stage-step {
        color: #9aa2a8;
        font-variant-numeric: tabular-nums;
        margin-right: 7px;
      }
      .boot-progress {
        background: rgba(122, 131, 138, 0.18);
        border-radius: 999px;
        bottom: 84px;
        height: 3px;
        left: 50%;
        overflow: hidden;
        position: fixed;
        transform: translateX(-50%);
        width: 200px;
      }
      .boot-progress-fill {
        background: #7a838a;
        border-radius: 999px;
        height: 100%;
        transition: width 320ms cubic-bezier(0.23, 1, 0.32, 1);
      }
      .boot-dots .dot {
        animation: boot-dot 1.4s cubic-bezier(0.23, 1, 0.32, 1) infinite;
        display: inline-block;
      }
      .boot-dots .dot:nth-child(2) { animation-delay: 0.2s; }
      .boot-dots .dot:nth-child(3) { animation-delay: 0.4s; }
      @keyframes boot-dot {
        0%, 60%, 100% { opacity: 0.25; }
        30% { opacity: 1; }
      }
    </style>
  </head>
  <body>
    <div class="brand" aria-label="Mishh Mashh"><svg xmlns="http://www.w3.org/2000/svg" viewBox="340 600 1368 850"><path fill="#151719" d="M 1438.61 689.472 C 1445.77 693.501 1481.13 725.102 1489.31 732.22 C 1527.98 766.459 1567.08 800.201 1606.62 833.437 C 1593.64 852.083 1574.67 875.554 1560.49 893.614 L 1493.87 979.327 L 1349.77 1167.69 C 1302.41 1229.17 1252.96 1292.04 1207.11 1354.47 C 1206.87 1354.74 1205.58 1355.47 1205.21 1355.69 C 1189.19 1339.57 1160.75 1316.32 1142.75 1300.92 L 1041.7 1214.38 C 1046.27 1206.03 1054.57 1195.25 1060.29 1187.36 C 1070.91 1172.6 1081.73 1157.98 1092.72 1143.49 L 1169.19 1041.93 L 1438.61 689.472 z"/><path fill="#151719" d="M 1127.65 693.457 C 1132.61 695.449 1173.68 732.312 1180.36 738.119 L 1295.95 838.444 C 1283.17 857.67 1265.58 879.343 1251.3 897.733 L 1183.65 985.126 L 983.27 1247.25 C 956.664 1282.39 926.202 1319.56 900.853 1355.15 L 899.003 1356.67 C 891.64 1353.96 753.332 1232.11 735.97 1216.23 C 747.094 1199.17 762.662 1179.09 774.906 1162.47 L 855.364 1054.34 C 945.08 933.258 1035.85 812.96 1127.65 693.457 z"/><path fill="#151719" d="M 797.842 713.795 C 799.964 715.963 799.089 748.117 799.084 753.92 L 798.996 830.772 L 798.723 1092.35 C 749.881 1157.91 697.11 1222.5 648.664 1288.59 C 632.079 1311.22 612.77 1334.19 597.182 1357.23 C 570.124 1332.48 537.221 1306.01 508.998 1281.3 C 482.076 1258.89 454.4 1234.23 427.836 1211.24 L 797.842 713.795 z"/><path fill="#151719" d="M 1615.65 841.765 C 1620.13 847.604 1610.95 1309.51 1611.38 1358.05 L 1385.1 1358 C 1382.78 1349.19 1384.38 1284.72 1384.49 1272.52 L 1385 1140.99 L 1615.65 841.765 z"/><path fill="#151719" d="M 812.464 694.663 C 823.636 702.363 839.562 717.778 850.665 727.108 C 878.412 750.616 905.964 774.353 933.318 798.318 C 952.568 815.145 971.996 832.816 992.248 848.322 C 982.97 861.664 972.932 874.511 963.43 887.714 C 938.655 922.719 913.313 957.318 887.414 991.5 C 861.288 1026.57 835.437 1061.84 809.862 1097.32 C 811.18 1083.04 810.882 1064.99 810.919 1050.33 L 810.959 978.283 L 811.272 821 C 811.274 780.686 810.839 734.726 812.464 694.663 z"/></svg><div class="brand-name">Mishh Mashh</div><div class="brand-note">Make something that feels like you.</div></div>
    <div class="boot-progress" aria-hidden="true">
      <div class="boot-progress-fill" id="boot-progress-fill" data-pct="${initialPct}" style="width: ${initialPct}%;"></div>
    </div>
    <div class="boot-stage" id="boot-stage" aria-live="polite">
      <span class="boot-stage-step" id="boot-stage-step">${start.step}/${start.total}</span><span id="boot-stage-text">${start.label}</span><span class="boot-dots" aria-hidden="true"><span class="dot">.</span><span class="dot">.</span><span class="dot">.</span></span>
    </div>
    <script>
      // Accepts the structured { step, total, label } payload (and tolerates a
      // bare label string for back-compat). The step counter + progress bar give
      // a slow cold boot a sense of how far along it is; the bar only ever grows
      // so a re-asserted earlier stage cannot make it lurch backwards.
      window.__odSplashSetStage = function (info) {
        var data = (typeof info === "string") ? { label: info } : (info || {});
        var wrap = document.getElementById("boot-stage");
        var text = document.getElementById("boot-stage-text");
        var stepEl = document.getElementById("boot-stage-step");
        var fill = document.getElementById("boot-progress-fill");
        if (!wrap || !text) return;
        var step = (typeof data.step === "number") ? data.step : null;
        var total = (typeof data.total === "number" && data.total > 0) ? data.total : null;
        if (fill && step != null && total != null) {
          var pct = Math.max(0, Math.min(100, Math.round((step / total) * 100)));
          var prev = parseFloat(fill.getAttribute("data-pct")) || 0;
          if (pct >= prev) {
            fill.style.width = pct + "%";
            fill.setAttribute("data-pct", String(pct));
          }
        }
        var label = (typeof data.label === "string") ? data.label : null;
        var stepText = (step != null && total != null) ? (step + "/" + total) : null;
        var labelSame = (label == null) || text.textContent === label;
        var stepSame = (stepText == null) || !stepEl || stepEl.textContent === stepText;
        if (labelSame && stepSame) return;
        wrap.classList.add("boot-stage-swapping");
        setTimeout(function () {
          if (label != null) text.textContent = label;
          if (stepEl && stepText != null) stepEl.textContent = stepText;
          wrap.classList.remove("boot-stage-swapping");
        }, 140);
      };
    </script>
  </body>
</html>`)}`;
}
