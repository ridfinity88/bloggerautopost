(() => {
  'use strict';

  const CONFIG = window.APP_CONFIG || {};
  const state = {
    bridgePort: null,
    selectedImage: null,
    requestSeq: 0,
    pending: new Map()
  };

  const $ = id => document.getElementById(id);
  const els = {};

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    cacheEls();
    bindEvents();
    updateMiniPreview();

    if (!CONFIG.GAS_EXEC_URL || CONFIG.GAS_EXEC_URL.includes('PASTE_YOUR')) {
      showToast('กรุณาใส่ GAS_EXEC_URL ใน config.js ก่อนใช้งาน');
      return;
    }

    try {
      await connectBridge();
    } catch (error) {
      console.error(error);
      showToast(error.message || 'เชื่อมต่อระบบไม่สำเร็จ');
    }
  }

  function cacheEls() {
    [
      'gasBridge','postForm','postTitle','postImage','uploadEmpty','imagePreviewWrap',
      'imagePreview','removeImageBtn','postHeading','content1','postLink','saveYoutubeBtn',
      'content2','labels','miniPreview','publishBtn','publishTopBtn','loadAllBtn','toast','successModal','closeModalBtn'
    ].forEach(id => els[id] = $(id));
  }

  function bindEvents() {
    document.querySelectorAll('[data-pull-cell]').forEach(btn => {
      btn.addEventListener('click', () => pullCellIntoField(btn));
    });

    els.loadAllBtn.addEventListener('click', loadAllFields);
    els.saveYoutubeBtn.addEventListener('click', saveYoutubeToSheet);
    els.postImage.addEventListener('change', onImageSelected);
    els.removeImageBtn.addEventListener('click', () => clearImage(true));
    els.postForm.addEventListener('submit', publishPost);
    els.closeModalBtn.addEventListener('click', () => els.successModal.classList.add('hidden'));

    ['postTitle','postHeading','content1','postLink','content2','labels'].forEach(id => {
      els[id].addEventListener('input', updateMiniPreview);
    });
  }

  function connectBridge() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('เชื่อมต่อ Apps Script ใช้เวลานานเกินไป')), 20000);

      const onReady = event => {
        const data = event.data || {};
        if (data.channel !== 'blogger-post-bridge' || data.type !== 'ready') return;
        if (!event.ports || !event.ports[0]) return;

        window.removeEventListener('message', onReady);
        clearTimeout(timeout);

        state.bridgePort = event.ports[0];
        state.bridgePort.onmessage = handleBridgeMessage;
        if (state.bridgePort.start) state.bridgePort.start();
        resolve();
      };

      window.addEventListener('message', onReady);
      els.gasBridge.src = CONFIG.GAS_EXEC_URL;
    });
  }

  function handleBridgeMessage(event) {
    const data = event.data || {};
    if (data.channel !== 'blogger-post-bridge' || data.type !== 'response') return;
    const pending = state.pending.get(data.id);
    if (!pending) return;

    state.pending.delete(data.id);
    clearTimeout(pending.timeout);

    if (data.ok) pending.resolve(data.result);
    else pending.reject(new Error(data.error || 'Backend error'));
  }

  function bridgeCall(action, payload = {}) {
    if (!state.bridgePort) return Promise.reject(new Error('Backend ยังไม่พร้อม'));

    const id = `req-${Date.now()}-${++state.requestSeq}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error('คำขอหมดเวลา กรุณาลองใหม่'));
      }, 30000);

      state.pending.set(id, { resolve, reject, timeout });
      state.bridgePort.postMessage({
        channel: 'blogger-post-bridge',
        type: 'request',
        id,
        action,
        payload
      });
    });
  }

  async function loadAllFields() {
    setActionBusy(els.loadAllBtn, true, 'กำลังดึง...');
    try {
      const result = await bridgeCall('getAllCells', {});
      const data = result && result.values ? result.values : {};
      els.postTitle.value = data.A2 ?? '';
      els.postHeading.value = data.B2 ?? '';
      els.content1.value = data.C2 ?? '';
      els.postLink.value = data.D2 ?? '';
      els.content2.value = data.E2 ?? '';
      els.labels.value = data.F2 ?? '';
      updateMiniPreview();
      showToast('ดึงข้อมูล A2:F2 เรียบร้อยแล้ว');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'ดึงข้อมูลทั้งหมดไม่สำเร็จ');
    } finally {
      setActionBusy(els.loadAllBtn, false, 'ดึงข้อมูลทั้งหมด');
    }
  }

  async function pullCellIntoField(button) {
    const cell = String(button.dataset.pullCell || '').trim().toUpperCase();
    const map = {
      A2: 'postTitle',
      B2: 'postHeading',
      C2: 'content1',
      D2: 'postLink',
      E2: 'content2',
      F2: 'labels'
    };
    const targetId = map[cell];
    if (!targetId) return;

    setActionBusy(button, true, 'กำลังดึง...');
    try {
      const result = await bridgeCall('getCell', { cell });
      els[targetId].value = result?.value ?? '';
      updateMiniPreview();
      showToast(`ดึงข้อมูลจาก ${cell} แล้ว`);
    } catch (error) {
      console.error(error);
      showToast(error.message || `ดึงข้อมูลจาก ${cell} ไม่สำเร็จ`);
    } finally {
      setActionBusy(button, false, 'ดึงข้อมูล');
    }
  }

  async function saveYoutubeToSheet() {
    const value = els.postLink.value.trim();
    if (!value) {
      showToast('กรุณาพิมพ์ลิ้งค์ YouTube ก่อนส่งไป D2');
      return;
    }

    if (!extractYoutubeVideoId(value)) {
      showToast('ลิ้งค์ YouTube ไม่ถูกต้อง');
      return;
    }

    setActionBusy(els.saveYoutubeBtn, true, 'กำลังส่ง...');
    try {
      await bridgeCall('setYoutubeLink', { value });
      showToast('ส่งลิ้งค์ YouTube ไปแทนที่ D2 แล้ว');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'ส่งลิ้งค์ไป D2 ไม่สำเร็จ');
    } finally {
      setActionBusy(els.saveYoutubeBtn, false, 'ส่งไป D2');
    }
  }

  function setActionBusy(button, busy, label) {
    button.disabled = busy;
    button.textContent = label;
  }

  async function onImageSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.type)) {
      showToast('รองรับเฉพาะ JPEG, PNG และ WebP');
      els.postImage.value = '';
      return;
    }

    if (file.size > 12 * 1024 * 1024) {
      showToast('รูปต้นฉบับใหญ่เกิน 12 MB กรุณาเลือกรูปที่เล็กลง');
      els.postImage.value = '';
      return;
    }

    try {
      setPublishBusy(true, 'กำลังเตรียมรูป...');
      const compressed = await resizeImage(file, 1200, 1200, 0.84);
      state.selectedImage = compressed;
      showImagePreview(compressed.dataUrl);
      showToast('เตรียมรูปภาพเรียบร้อย');
    } catch (error) {
      console.error(error);
      showToast('ไม่สามารถอ่านรูปภาพนี้ได้ กรุณาเลือกรูปใหม่');
      clearImage(false);
    } finally {
      setPublishBusy(false);
    }
  }

  async function resizeImage(file, maxW, maxH, quality) {
    const dataUrl = await fileToDataUrl(file);
    const img = await loadImage(dataUrl);
    const scale = Math.min(1, maxW / img.width, maxH / img.height);
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);

    const out = canvas.toDataURL('image/jpeg', quality);
    return {
      dataUrl: out,
      base64: out.split(',')[1],
      mimeType: 'image/jpeg',
      fileName: `blogger-${Date.now()}.jpg`,
      width,
      height
    };
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('อ่านไฟล์ไม่สำเร็จ'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('รูปภาพไม่รองรับ'));
      img.src = src;
    });
  }

  function showImagePreview(src) {
    els.imagePreview.src = src;
    els.uploadEmpty.classList.add('hidden');
    els.imagePreviewWrap.classList.remove('hidden');
    els.removeImageBtn.classList.remove('hidden');
    updateMiniPreview();
  }

  function clearImage(showMessage = false) {
    state.selectedImage = null;
    els.postImage.value = '';
    els.imagePreview.removeAttribute('src');
    els.uploadEmpty.classList.remove('hidden');
    els.imagePreviewWrap.classList.add('hidden');
    els.removeImageBtn.classList.add('hidden');
    updateMiniPreview();
    if (showMessage) showToast('เอารูปออกแล้ว');
  }

  async function publishPost(event) {
    event.preventDefault();

    const payload = {
      title: els.postTitle.value.trim(),
      heading: els.postHeading.value,
      content1: els.content1.value,
      link: els.postLink.value.trim(),
      content2: els.content2.value,
      labels: els.labels.value.trim(),
      image: state.selectedImage ? {
        base64: state.selectedImage.base64,
        mimeType: state.selectedImage.mimeType,
        fileName: state.selectedImage.fileName
      } : null
    };

    if (!hasAnyContent(payload)) {
      showToast('กรุณาใส่ข้อมูลอย่างน้อย 1 รายการก่อนโพส');
      return;
    }

    if (payload.link && !extractYoutubeVideoId(payload.link)) {
      showToast('ลิ้งค์ YouTube ไม่ถูกต้อง');
      return;
    }

    setPublishBusy(true, 'กำลังโพส...');
    try {
      const result = await bridgeCall('publishPost', payload);
      if (!result?.ok) throw new Error(result?.message || 'โพสต์ไม่สำเร็จ');
      els.successModal.classList.remove('hidden');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'โพสต์ไม่สำเร็จ');
    } finally {
      setPublishBusy(false);
    }
  }

  function hasAnyContent(payload) {
    return Boolean(
      payload.title || payload.heading || payload.content1 || payload.link ||
      payload.content2 || payload.labels || payload.image
    );
  }

  function setPublishBusy(busy, label) {
    [els.publishBtn, els.publishTopBtn].forEach(button => {
      if (!button) return;
      button.disabled = busy;
      const btnLabel = button.querySelector('.btn-label');
      const spinner = button.querySelector('.spinner');
      if (btnLabel) btnLabel.textContent = busy ? (label || 'กำลังทำงาน...') : 'โพส';
      if (spinner) spinner.classList.toggle('hidden', !busy);
    });
  }

  function updateMiniPreview() {
    const parts = [];

    if (els.postTitle.value.trim()) {
      parts.push(`<strong>${escapeHtml(els.postTitle.value.trim())}</strong>`);
    }
    if (state.selectedImage) {
      parts.push('🖼️ รูปภาพ 1 รูป');
    }
    if (els.postHeading.value.trim()) {
      parts.push(`<strong style="font-size:1.08em">${escapeHtml(shorten(els.postHeading.value.trim(), 120))}</strong>`);
    }
    if (els.content1.value.trim()) {
      parts.push(escapeHtml(shorten(els.content1.value.trim(), 130)));
    }
    if (els.postLink.value.trim()) {
      parts.push(`▶️ YouTube: ${escapeHtml(shorten(els.postLink.value.trim(), 80))}`);
    }
    if (els.content2.value.trim()) {
      parts.push(escapeHtml(shorten(els.content2.value.trim(), 130)));
    }

    const tags = makeHashtags(els.labels.value);
    if (tags) {
      parts.push(`<span style="color:#0f766e">${escapeHtml(tags)}</span>`);
    }

    els.miniPreview.innerHTML = parts.length
      ? parts.join('<br><br>')
      : 'กรอกข้อมูลเพื่อดูตัวอย่างก่อนโพสต์';
  }

  function makeHashtags(value) {
    return String(value || '')
      .split(/[,\n]+/)
      .map(v => v.trim())
      .filter(Boolean)
      .map(v => '#' + v.replace(/^#+/, '').replace(/\s+/g, '_'))
      .join(' ');
  }

  function extractYoutubeVideoId(value) {
    const text = String(value || '').trim();
    if (!text) return '';

    let url;
    try {
      url = new URL(text);
    } catch (_) {
      return '';
    }

    const host = String(url.hostname || '').toLowerCase().replace(/^www\./, '');
    let videoId = '';

    if (host === 'youtu.be') {
      videoId = url.pathname.split('/').filter(Boolean)[0] || '';
    } else if (host === 'youtube.com' || host === 'm.youtube.com') {
      if (url.pathname === '/watch') {
        videoId = url.searchParams.get('v') || '';
      } else {
        const parts = url.pathname.split('/').filter(Boolean);
        if (['embed', 'shorts', 'live'].includes(parts[0])) {
          videoId = parts[1] || '';
        }
      }
    }

    videoId = String(videoId || '').trim();
    return /^[A-Za-z0-9_-]{6,20}$/.test(videoId) ? videoId : '';
  }

  function shorten(text, max) {
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>'"]/g, ch => ({
      '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
    })[ch]);
  }

  let toastTimer = null;
  function showToast(message) {
    clearTimeout(toastTimer);
    els.toast.textContent = message;
    els.toast.classList.remove('hidden');
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3200);
  }
})();
