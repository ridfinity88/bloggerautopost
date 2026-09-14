(() => {
  'use strict';

  const CONFIG = window.APP_CONFIG || {};
  const state = {
    bridgePort: null,
    rows: [],
    selectedImage: null,
    previewUrl: '',
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
      els.sourceRow.innerHTML = '<option value="">ยังไม่ได้ตั้งค่า Backend</option>';
      return;
    }

    try {
      await connectBridge();
      await loadRows();
    } catch (error) {
      console.error(error);
      showToast(error.message || 'เชื่อมต่อระบบไม่สำเร็จ');
      els.sourceRow.innerHTML = '<option value="">โหลดข้อมูลไม่สำเร็จ</option>';
    }
  }

  function cacheEls() {
    [
      'gasBridge','sourceRow','refreshBtn','pullAllBtn','postForm','postTitle','postImage',
      'uploadEmpty','imagePreviewWrap','imagePreview','removeImageBtn','content1','postLink',
      'content2','labels','miniPreview','publishBtn','toast','successModal','closeModalBtn'
    ].forEach(id => els[id] = $(id));
  }

  function bindEvents() {
    els.refreshBtn.addEventListener('click', loadRows);
    els.pullAllBtn.addEventListener('click', pullAllFields);
    document.querySelectorAll('[data-pull]').forEach(btn => {
      btn.addEventListener('click', () => pullOneField(btn.dataset.pull));
    });
    els.postImage.addEventListener('change', onImageSelected);
    els.removeImageBtn.addEventListener('click', clearImage);
    els.postForm.addEventListener('submit', publishPost);
    els.closeModalBtn.addEventListener('click', () => els.successModal.classList.add('hidden'));
    ['postTitle','content1','postLink','content2','labels'].forEach(id => {
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

  async function loadRows() {
    setSourceBusy(true);
    try {
      const result = await bridgeCall('listRows');
      state.rows = Array.isArray(result?.rows) ? result.rows : [];
      renderRowOptions();
      showToast(`โหลดข้อมูล ${state.rows.length} แถวแล้ว`);
    } catch (error) {
      console.error(error);
      showToast(error.message || 'โหลด Google Sheet ไม่สำเร็จ');
    } finally {
      setSourceBusy(false);
    }
  }

  function setSourceBusy(busy) {
    els.refreshBtn.disabled = busy;
    if (busy) els.sourceRow.innerHTML = '<option value="">กำลังโหลดข้อมูล...</option>';
  }

  function renderRowOptions() {
    els.sourceRow.innerHTML = '<option value="">-- เลือกแถวข้อมูล --</option>';
    state.rows.forEach(row => {
      const option = document.createElement('option');
      option.value = String(row.rowNumber);
      const title = String(row.title || '').trim() || '(ไม่มีชื่อโพส)';
      option.textContent = `แถว ${row.rowNumber} • ${title}`;
      els.sourceRow.appendChild(option);
    });
  }

  function getSelectedRow() {
    const rowNumber = Number(els.sourceRow.value);
    if (!rowNumber) {
      showToast('กรุณาเลือกแถวข้อมูลจาก Google Sheet ก่อน');
      return null;
    }
    return state.rows.find(row => Number(row.rowNumber) === rowNumber) || null;
  }

  function pullOneField(field) {
    const row = getSelectedRow();
    if (!row) return;
    const map = {
      title: 'postTitle',
      content1: 'content1',
      link: 'postLink',
      content2: 'content2',
      labels: 'labels'
    };
    const targetId = map[field];
    if (!targetId) return;
    els[targetId].value = row[field] ?? '';
    updateMiniPreview();
    showToast('ดึงข้อมูลแล้ว');
  }

  function pullAllFields() {
    const row = getSelectedRow();
    if (!row) return;
    els.postTitle.value = row.title ?? '';
    els.content1.value = row.content1 ?? '';
    els.postLink.value = row.link ?? '';
    els.content2.value = row.content2 ?? '';
    els.labels.value = row.labels ?? '';
    updateMiniPreview();
    showToast('ดึงข้อมูลทั้งหมดแล้ว');
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
      clearImage();
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
  }

  function clearImage() {
    state.selectedImage = null;
    els.postImage.value = '';
    els.imagePreview.removeAttribute('src');
    els.uploadEmpty.classList.remove('hidden');
    els.imagePreviewWrap.classList.add('hidden');
    els.removeImageBtn.classList.add('hidden');
  }

  async function publishPost(event) {
    event.preventDefault();

    const payload = {
      title: els.postTitle.value.trim(),
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

    setPublishBusy(true, 'กำลังโพส...');
    try {
      const result = await bridgeCall('publishPost', payload);
      if (!result?.ok) throw new Error(result?.message || 'โพสต์ไม่สำเร็จ');
      els.successModal.classList.remove('hidden');
    } catch (error) {
      console.error(error);
      showToast(error.message || 'โพสต์ไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      setPublishBusy(false);
    }
  }

  function hasAnyContent(payload) {
    return Boolean(
      payload.title || payload.content1 || payload.link || payload.content2 || payload.labels || payload.image
    );
  }

  function setPublishBusy(busy, label) {
    els.publishBtn.disabled = busy;
    const btnLabel = els.publishBtn.querySelector('.btn-label');
    const spinner = els.publishBtn.querySelector('.spinner');
    if (btnLabel) btnLabel.textContent = busy ? (label || 'กำลังทำงาน...') : '7. โพสทันที';
    if (spinner) spinner.classList.toggle('hidden', !busy);
  }

  function updateMiniPreview() {
    const parts = [];
    if (els.postTitle.value.trim()) parts.push(`<strong>${escapeHtml(els.postTitle.value.trim())}</strong>`);
    if (els.content1.value.trim()) parts.push(escapeHtml(shorten(els.content1.value.trim(), 130)));
    if (els.postLink.value.trim()) parts.push(`▶️ YouTube: ${escapeHtml(shorten(els.postLink.value.trim(), 80))}`);
    if (els.content2.value.trim()) parts.push(escapeHtml(shorten(els.content2.value.trim(), 130)));
    const tags = makeHashtags(els.labels.value);
    if (tags) parts.push(`<span style="color:#0f766e">${escapeHtml(tags)}</span>`);
    els.miniPreview.innerHTML = parts.length ? parts.join('<br><br>') : 'กรอกข้อมูลเพื่อดูตัวอย่างก่อนโพสต์';
  }

  function makeHashtags(value) {
    return String(value || '')
      .split(/[,\n]+/)
      .map(v => v.trim())
      .filter(Boolean)
      .map(v => '#' + v.replace(/^#+/, '').replace(/\s+/g, '_'))
      .join(' ');
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
