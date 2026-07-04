const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = __dirname;
const chunkDir = path.join(root, "deploy-bundle");
const overridesDir = path.join(root, "deploy-overrides");
const overrideBundlePath = path.join(root, "deploy-overrides.b64");
const overrideBundleDir = path.join(root, "deploy-overrides-bundle");
const extraOverrideBundleDir = path.join(root, "deploy-extra-overrides-bundle");
let chunks = fs
  .readdirSync(chunkDir)
  .filter((name) => /^chunk-\d+\.txt$/.test(name))
  .sort()
  .map((name) => fs.readFileSync(path.join(chunkDir, name), "utf8"))
  .join("")
  .replace(/\s+/g, "");

const knownChunkRepair = "IzPVwMbps3GV8gvzu17mRfEAuA";
if (chunks.includes(knownChunkRepair)) {
  chunks = chunks.replace(knownChunkRepair, "IzPVwPbsMbps3GV8gvzu17mRfEAuA");
  console.log("Applied deployment bundle chunk repair.");
}

const payload = JSON.parse(zlib.gunzipSync(Buffer.from(chunks, "base64")).toString("utf8"));

function writePayloadFile(file) {
  const target = path.join(root, file.path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(file.content, "base64"));
}

for (const file of payload.files) writePayloadFile(file);

function copyOverrides(sourceDir, relativeDir = "") {
  if (!fs.existsSync(sourceDir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const source = path.join(sourceDir, entry.name);
    const relativePath = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      count += copyOverrides(source, relativePath);
    } else {
      const target = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      count += 1;
    }
  }
  return count;
}

function readBundleChunks(bundleDir, pattern) {
  if (!fs.existsSync(bundleDir)) return "";
  return fs
    .readdirSync(bundleDir)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => fs.readFileSync(path.join(bundleDir, name), "utf8"))
    .join("");
}

function readOverrideBundle() {
  const parts = [];
  if (fs.existsSync(overrideBundlePath)) parts.push(fs.readFileSync(overrideBundlePath, "utf8"));
  parts.push(readBundleChunks(overrideBundleDir, /^override-\d+\.txt$/));
  return parts.join("").replace(/\s+/g, "");
}

function applyOverrideBundleFromRaw(raw) {
  if (!raw) return 0;
  const overrides = JSON.parse(zlib.gunzipSync(Buffer.from(raw, "base64")).toString("utf8"));
  for (const file of overrides.files || []) writePayloadFile(file);
  return (overrides.files || []).length;
}

function applyOverrideBundle() {
  return applyOverrideBundleFromRaw(readOverrideBundle());
}

function applyExtraOverrideBundle() {
  const raw = readBundleChunks(extraOverrideBundleDir, /^extra-\d+\.txt$/).replace(/\s+/g, "");
  if (!raw) return 0;
  try {
    return applyOverrideBundleFromRaw(raw);
  } catch (error) {
    console.warn(`Skipped incomplete extra deployment override bundle: ${error.message || error}`);
    return 0;
  }
}

function patchTextFile(relativePath, patcher) {
  const target = path.join(root, relativePath);
  if (!fs.existsSync(target)) return 0;
  const before = fs.readFileSync(target, "utf8");
  const after = patcher(before);
  if (after === before) return 0;
  fs.writeFileSync(target, after, "utf8");
  return 1;
}

function replaceFunction(source, functionName, replacement) {
  const escapedName = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`  function ${escapedName}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n(?=\\n  function )`);
  if (!pattern.test(source)) return source;
  return source.replace(pattern, () => `${replacement}\n`);
}

function applyMusicAdminPatch() {
  let patchedFiles = 0;

  patchedFiles += patchTextFile("admin.html", (source) => {
    if (source.includes('id="music-editor"')) return source;
    return source.replace(
      '        <section class="admin-panel" id="memory-images-editor"></section>\n        <section class="admin-panel" id="videos-editor"></section>',
      '        <section class="admin-panel" id="memory-images-editor"></section>\n        <section class="admin-panel" id="music-editor"></section>\n        <section class="admin-panel" id="videos-editor"></section>'
    );
  });

  patchedFiles += patchTextFile("admin.js", (source) => {
    let next = source;

    if (!next.includes('music: $("#music-editor")')) {
      next = next.replace(
        '    memoryImages: $("#memory-images-editor"),\n    videos: $("#videos-editor"),',
        '    memoryImages: $("#memory-images-editor"),\n    music: $("#music-editor"),\n    videos: $("#videos-editor"),'
      );
    }

    if (!next.includes('return "audio/*"')) {
      next = replaceFunction(next, "uploadAccept", [
        '  function uploadAccept(uploadType) {',
        '    if (uploadType === "video") return "video/*";',
        '    if (uploadType === "image") return "image/*";',
        '    if (uploadType === "audio") return "audio/*";',
        '    return "*/*";',
        '  }'
      ].join("\n"));
    }

    if (!next.includes('audio: ["mp3"')) {
      const fileHasTypeReplacement = [
        '  function fileHasType(file, uploadType) {',
        '    const type = file.type || "";',
        '    const extension = (file.name.split(".").pop() || "").toLowerCase();',
        '    const extensions = {',
        '      image: ["jpg", "jpeg", "png", "webp", "gif", "avif"],',
        '      video: ["mp4", "mov", "m4v", "webm"],',
        '      audio: ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac"]',
        '    };',
        '',
        '    if (type.startsWith(`${uploadType}/`)) return true;',
        '    return (extensions[uploadType] || []).includes(extension);',
        '  }'
      ].join("\n");

      if (next.includes("function fileHasType(file, uploadType)")) {
        next = replaceFunction(next, "fileHasType", fileHasTypeReplacement);
      } else {
        next = next.replace('  function validateUploadFile', `${fileHasTypeReplacement}\n\n  function validateUploadFile`);
      }
    }

    if (!next.includes('Please choose an audio file.')) {
      next = replaceFunction(next, "validateUploadFile", [
        '  function validateUploadFile(file, uploadType) {',
        '    if (!file) return "Choose a file first.";',
        '    if (uploadType === "image" && !fileHasType(file, "image")) return "Please choose an image file.";',
        '    if (uploadType === "video" && !fileHasType(file, "video")) return "Please choose a video file.";',
        '    if (uploadType === "audio" && !fileHasType(file, "audio")) return "Please choose an audio file.";',
        '    return "";',
        '  }'
      ].join("\n"));
    }

    if (!next.includes('Choose a song or audio file from your phone.')) {
      next = replaceFunction(next, "uploadHint", [
        '  function uploadHint(uploadType) {',
        '    if (uploadType === "video") return "Choose a video from your phone.";',
        '    if (uploadType === "audio") return "Choose a song or audio file from your phone.";',
        '    return "Choose a photo from your phone.";',
        '  }'
      ].join("\n"));
    }

    if (!next.includes('field.uploadType === "audio" && field.path === "music.src"')) {
      next = next.replace(
        [
          '        if (field.uploadType === "video" && field.key === "src") {',
          '          const placeholderToggle = $(`[data-item-key="placeholder"]`, itemCard);',
          '          if (placeholderToggle) placeholderToggle.checked = false;',
          '        }',
          '',
          '        content = collectForm();'
        ].join("\n"),
        [
          '        if (field.uploadType === "video" && field.key === "src") {',
          '          const placeholderToggle = $(`[data-item-key="placeholder"]`, itemCard);',
          '          if (placeholderToggle) placeholderToggle.checked = false;',
          '        }',
          '',
          '        if (field.uploadType === "audio" && field.path === "music.src") {',
          '          const useFileToggle = $(\'[data-path="music.useFile"]\');',
          '          if (useFileToggle) useFileToggle.checked = true;',
          '        }',
          '',
          '        content = collectForm();'
        ].join("\n")
      );
    }

    if (!next.includes('const control = $(`[data-path="${field.path}"]`, fieldElement);')) {
      const fieldUploadBlock = [
        '      const fieldElement = createField(field, value);',
        '      if (field.uploadType) {',
        '        const control = $(`[data-path="${field.path}"]`, fieldElement);',
        '        if (control) fieldElement.appendChild(createUploadControl(field, control));',
        '      }',
        '      grid.appendChild(fieldElement);'
      ].join("\n");
      next = next.replace('      grid.appendChild(createField(field, value));', fieldUploadBlock);
      next = next.replace(
        '      const fieldElement = createField(field, value);\n      grid.appendChild(fieldElement);',
        fieldUploadBlock
      );
    }

    if (!next.includes('function renderMusicEditor()')) {
      const renderMusicEditor = [
        '  function renderMusicEditor() {',
        '    const section = buildPanel(',
        '      sections.music,',
        '      "Music",',
        '      "Background Music",',
        '      "Upload or replace the romantic background song used by the birthday and journey pages."',
        '    );',
        '',
        '    appendFields(section, [',
        '      {',
        '        path: "music.src",',
        '        label: "Music URL or Path",',
        '        uploadType: "audio",',
        '        uploadFolder: "music",',
        '        uploadLabel: "Upload Music"',
        '      },',
        '      { path: "music.useFile", label: "Use Uploaded Music File", type: "checkbox" },',
        '      { path: "music.generatedFallback", label: "Use Soft Generated Music If File Cannot Play", type: "checkbox" },',
        '      {',
        '        path: "music.volume",',
        '        label: "Music Volume",',
        '        type: "number",',
        '        attrs: { min: "0", max: "1", step: "0.05" },',
        '        placeholder: "0.34"',
        '      }',
        '    ]);',
        '  }',
        ''
      ].join("\n");
      next = next.replace('  function renderVideosEditor() {', `${renderMusicEditor}\n  function renderVideosEditor() {`);
    }

    if (!next.includes('    renderMusicEditor();')) {
      next = next.replace(
        '    renderImageEditors();\n    renderVideosEditor();',
        '    renderImageEditors();\n    renderMusicEditor();\n    renderVideosEditor();'
      );
    }

    return next;
  });

  patchedFiles += patchTextFile("config.js", (source) => {
    if (/music:\s*\{[\s\S]*?volume\s*:/.test(source)) return source;
    return source.replace(
      /(music:\s*\{[\s\S]*?generatedFallback:\s*true)(,?\s*\n\s*\})/,
      '$1,\n    volume: 0.34$2'
    );
  });

  patchedFiles += patchTextFile("script.js", (source) => {
    if (source.includes("const configuredVolume = Number(config.music.volume);")) return source;
    return source.replace(
      /fileAudio\.volume\s*=\s*0\.\d+;/,
      'const configuredVolume = Number(config.music.volume);\n      fileAudio.volume = Math.max(0, Math.min(1, Number.isFinite(configuredVolume) ? configuredVolume : 0.34));'
    );
  });

  patchedFiles += patchTextFile("storage.js", (source) =>
    source.replace("Choose an image or video file first.", "Choose an image, video, or audio file first.")
  );

  return patchedFiles;
}

const overrideCount = copyOverrides(overridesDir) + applyOverrideBundle() + applyExtraOverrideBundle();
if (overrideCount) console.log(`Applied ${overrideCount} deployment override files.`);
const musicPatchCount = applyMusicAdminPatch();
if (musicPatchCount) console.log(`Applied editable music admin patch to ${musicPatchCount} files.`);

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";

if (process.env.VERCEL && (!supabaseUrl || !supabaseAnonKey)) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in Vercel environment variables.");
  process.exit(1);
}

const runtimeConfig = `window.BANSARI_RUNTIME_CONFIG = ${JSON.stringify(
  { supabaseUrl, supabaseAnonKey },
  null,
  2
)};\n`;

fs.writeFileSync(path.join(root, "runtime-config.js"), runtimeConfig, "utf8");
console.log(`Unpacked ${payload.files.length} site files and wrote runtime-config.js.`);

if (process.env.VERCEL) {
  fs.rmSync(chunkDir, { recursive: true, force: true });
  fs.rmSync(overridesDir, { recursive: true, force: true });
  fs.rmSync(overrideBundleDir, { recursive: true, force: true });
  fs.rmSync(extraOverrideBundleDir, { recursive: true, force: true });
  fs.rmSync(overrideBundlePath, { force: true });
}
