import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("every packaged Dink Vision logo matches the public source", () => {
  const publicLogo = readFileSync(resolve(root, "public/dink-vision-logo.png"));
  for (const path of [
    "app/icon.png",
    "android/app/src/main/assets/dink-vision-logo.png",
    "android/app/src/main/res/drawable/dink_vision_logo.png",
    "android/app/src/main/assets/wpc-logo.png",
    "android/app/src/main/res/drawable/wpc_logo.png",
  ]) {
    assert.deepEqual(readFileSync(resolve(root, path)), publicLogo, path);
  }
});

test("browser recordings load the public logo before writing frames", () => {
  const worker = readFileSync(resolve(root, "public/camera-transform-worker.js"), "utf8");
  assert.match(worker, /fetch\('\/dink-vision-logo\.png'/);
  assert.match(worker, /context\.drawImage\(logo/);
});

test("Android launcher and splash use the square logo without changing player branding", () => {
  const squareLogo = readFileSync(resolve(root, "public/dinkvision-logo-square-1x1.png"));
  assert.deepEqual(
    readFileSync(resolve(root, "android/app/src/main/res/drawable/dinkvision_logo_square_1x1.png")),
    squareLogo,
  );
  const launcher = readFileSync(
    resolve(root, "android/app/src/main/res/mipmap-anydpi-v26/dink_vision_launcher.xml"),
    "utf8",
  );
  const launcherForeground = readFileSync(
    resolve(root, "android/app/src/main/res/drawable/dink_vision_launcher_foreground.xml"),
    "utf8",
  );
  const splash = readFileSync(
    resolve(root, "android/app/src/main/res/drawable/dink_vision_splash.xml"),
    "utf8",
  );
  const splashIcon = readFileSync(
    resolve(root, "android/app/src/main/res/drawable/dink_vision_splash_icon.xml"),
    "utf8",
  );
  const styles = readFileSync(resolve(root, "android/app/src/main/res/values/styles.xml"), "utf8");
  const stylesV31 = readFileSync(
    resolve(root, "android/app/src/main/res/values-v31/styles.xml"),
    "utf8",
  );
  const manifest = readFileSync(resolve(root, "android/app/src/main/AndroidManifest.xml"), "utf8");
  assert.match(launcher, /<adaptive-icon/);
  assert.match(launcher, /@drawable\/dink_vision_launcher_foreground/);
  assert.match(launcherForeground, /android:left="18dp"/);
  assert.match(launcherForeground, /android:right="18dp"/);
  assert.match(launcherForeground, /@drawable\/dinkvision_logo_square_1x1/);
  assert.match(splash, /android:width="280dp"/);
  assert.match(splash, /android:height="280dp"/);
  assert.match(splash, /@drawable\/dinkvision_logo_square_1x1/);
  assert.match(splashIcon, /android:width="108dp"/);
  assert.match(splashIcon, /android:width="72dp"/);
  assert.match(splashIcon, /@android:color\/transparent/);
  assert.match(splashIcon, /@drawable\/dinkvision_logo_square_1x1/);
  assert.match(styles, /android:windowBackground">@drawable\/dink_vision_splash/);
  assert.match(stylesV31, /android:windowSplashScreenAnimatedIcon">@drawable\/dink_vision_splash_icon/);
  assert.doesNotMatch(stylesV31, /windowSplashScreenIconBackgroundColor/);
  assert.match(manifest, /android:icon="@mipmap\/dink_vision_launcher"/);
  assert.match(manifest, /android:roundIcon="@mipmap\/dink_vision_launcher_round"/);
});

test("Android player backgrounds match their public artwork and player shell stays scroll-free", () => {
  for (const name of ["Kiosk-Background-Phone.png", "Kiosk-Background-Tablet.png"]) {
    assert.deepEqual(
      readFileSync(resolve(root, `android/app/src/main/assets/${name}`)),
      readFileSync(resolve(root, `public/${name}`)),
      name,
    );
  }
  const html = readFileSync(resolve(root, "android/app/src/main/assets/index.html"), "utf8");
  const css = readFileSync(resolve(root, "android/app/src/main/assets/style.css"), "utf8");
  const app = readFileSync(resolve(root, "android/app/src/main/assets/app.js"), "utf8");
  const manifest = readFileSync(resolve(root, "android/app/src/main/AndroidManifest.xml"), "utf8");
  assert.match(html, /id="modal"[^>]*aria-modal="true"/);
  assert.equal((html.match(/class="brand"/g) || []).length, 1);
  assert.doesNotMatch(html, /class="watermark"|id="setup"/);
  assert.match(html, /id="reenroll" class="reenroll"/);
  assert.match(css, /\.reenroll\{[^}]*position:fixed[^}]*left:max\(12px/);
  assert.match(app, /call\('setup-reenroll'\)/);
  assert.doesNotMatch(html, />Tap to start</);
  assert.match(html, /id="begin"[^>]*aria-label="Tap anywhere to start"/);
  assert.doesNotMatch(html, /class="ripple-dot"/);
  assert.match(html, />TAP ANYWHERE TO START</);
  assert.match(css, /html,body\{[^}]*overflow:hidden/);
  assert.match(css, /\*\{[^}]*-webkit-tap-highlight-color:transparent/);
  assert.match(css, /\*\{[^}]*user-select:none/);
  assert.match(css, /input,textarea\{[^}]*user-select:text/);
  assert.doesNotMatch(css, /#welcome\{cursor:pointer\}/);
  assert.match(css, /\.subtitle\{[^}]*color:var\(--on-image\)/);
  assert.match(css, /\.note\{[^}]*color:var\(--on-image-soft\)/);
  assert.match(css, /#timer\{[^}]*color:var\(--on-image\)/);
  assert.match(app, /document\.addEventListener\('selectstart'/);
  assert.match(app, /document\.addEventListener\('contextmenu'/);
  assert.match(css, /url\('Kiosk-Background-Tablet\.png'\)/);
  assert.match(css, /url\('Kiosk-Background-Phone\.png'\)/);
  assert.match(css, /h1\{[^}]*-webkit-text-stroke:[^}]*text-shadow:/);
  assert.match(css, /\.intro\{[^}]*-webkit-text-stroke:[^}]*text-shadow:/);
  assert.doesNotMatch(css, /start-ripple/);
  assert.match(html, /id="back" class="player-back"/);
  assert.match(html, /viewBox="0 0 24 24"/);
  assert.match(css, /\.player-back svg\{[^}]*stroke:currentColor/);
  assert.match(html, /class="form-heading"/);
  assert.match(html, /class="record-icon"/);
  assert.match(css, /#email-form\{[^}]*flex-direction:column[^}]*width:min\(100%,620px\)/);
  assert.match(css, /\.record\{[^}]*align-self:center[^}]*border-radius:14px/);
  assert.doesNotMatch(css, /\.record\{[^}]*border-radius:50%/);
  assert.match(app, /\$\('welcome'\)\.addEventListener\('click'/);
  assert.match(app, /!event\.composedPath\(\)\.includes\(\$\('modal'\)\)/);
  assert.match(app, /window\.handlePlayerBack = handlePlayerBack/);
  assert.match(app, /event\.stopPropagation\(\)/);
  assert.doesNotMatch(app, /document\.body\.addEventListener\('click'/);
  assert.match(css, /\.modal\{[^}]*overflow:hidden/);
  assert.match(manifest, /android:windowSoftInputMode="adjustNothing"/);
  assert.doesNotMatch(css, /keyboard-open/);
});
