/**
 * RentyQ — Portail Cleaner Mobile V1 (Sprint 3)
 * Fichier totalement isolé de app.js : aucune fonction ici n'est appelée par app.js, et
 * app.js n'est jamais appelé par ce fichier (à l'exception du flag window.RQ_CLEANER_MODE,
 * lu par app.js au tout début de son IIFE d'init pour court-circuiter le flux propriétaire).
 *
 * Toutes les opérations passent par /api/cleaner-portal (Cloudflare Pages Function), qui utilise
 * la clé de service Supabase côté serveur — ce fichier ne contient et ne voit AUCUNE clé Supabase,
 * ni anonyme ni service. C'est la Function qui porte tout le cloisonnement de sécurité.
 */

(function () {
  'use strict';

  // ── Détection précoce du mode cleaner (s'exécute avant tout autre script deferred) ──
  var urlParams = new URLSearchParams(window.location.search);
  var tokenFromUrl = urlParams.get('cleaner_token');
  var token = tokenFromUrl || localStorage.getItem('rq_cleaner_token') || null;

  if (!token) return; // Pas de token : on ne touche à rien, app.js démarre normalement.

  if (tokenFromUrl) {
    try { localStorage.setItem('rq_cleaner_token', tokenFromUrl); } catch (e) {}
    // Nettoyage de l'URL : le token ne doit pas rester visible/partageable depuis la barre d'adresse.
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // Flag lu par app.js (une seule ligne ajoutée tout en haut de son IIFE d'init) pour ne JAMAIS
  // exécuter le moindre chargement de données propriétaire (finances, réservations, EVA...).
  window.RQ_CLEANER_MODE = true;
  window.RQ_CLEANER_TOKEN = token;

  // ── État local ──
  var currentCleaner = null;
  var cleanerMissions = [];
  var apartmentsById = {};
  var selectedMissionId = null;
  var uploadedPhotoUrls = [];

  function aptOf(m) { return apartmentsById[m.appartement_id] || null; }

  // ── Démarrage dès que le DOM est prêt ──
  document.addEventListener('DOMContentLoaded', function () {
    var appContainer = document.getElementById('app');
    var authScreen = document.getElementById('auth-screen');
    var loading = document.getElementById('loading');
    var cleanerApp = document.getElementById('cleaner-app');
    if (appContainer) appContainer.style.display = 'none';
    if (authScreen) authScreen.style.display = 'none';
    if (loading) loading.style.display = 'none';
    if (cleanerApp) cleanerApp.style.display = 'block';
    initCleanerPortal();
  });

  // ── Appel générique à la Function serveur ──
  async function callPortal(payload) {
    var res = await fetch('/api/cleaner-portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ token: token }, payload))
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      var err = new Error((data && data.error) || 'request_failed');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function initCleanerPortal() {
    try {
      var data = await callPortal({ action: 'auth' });
      currentCleaner = data.cleaner;
      cleanerMissions = Array.isArray(data.missions) ? data.missions : [];
      apartmentsById = {};
      (Array.isArray(data.apartments) ? data.apartments : []).forEach(function (a) { apartmentsById[a.id] = a; });

      var nameEl = document.getElementById('cleaner-profile-name');
      if (nameEl) nameEl.textContent = currentCleaner.name || 'Cleaner';

      renderMissionsList();
    } catch (err) {
      renderInvalidToken();
    }
  }

  // ── Rendu générique ──
  function renderCleanerScreen(html) {
    var el = document.getElementById('cleaner-main-container');
    if (el) el.innerHTML = html;
    window.scrollTo(0, 0);
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"]/g, function (m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m];
    });
  }

  function renderInvalidToken() {
    renderCleanerScreen(
      '<div style="text-align:center;padding:40px 20px">' +
        '<span style="font-size:48px">\u26A0\uFE0F</span>' +
        '<h2 class="cl-title" style="margin-top:20px">Lien non valide</h2>' +
        '<p style="color:#64748B;font-size:14px;line-height:1.6">Votre lien d\u2019acc\u00e8s n\u2019est plus valide ou a expir\u00e9. Veuillez contacter votre responsable d\u2019\u00e9quipe.</p>' +
      '</div>'
    );
  }

  function statusBadge(status) {
    if (status === 'en_cours') return '<span class="cl-badge cl-badge-progress">En cours</span>';
    if (status === 'terminee') return '<span class="cl-badge cl-badge-done">Termin\u00e9e</span>';
    if (status === 'probleme') return '<span class="cl-badge cl-badge-problem">Probl\u00e8me</span>';
    return '<span class="cl-badge cl-badge-todo">\u00c0 faire</span>';
  }

  // ── Écran 1 : liste des missions ──
  function renderMissionsList() {
    var todayStr = new Date().toISOString().slice(0, 10);
    var html = '<h2 class="cl-title">Mes missions</h2>';

    if (!cleanerMissions.length) {
      html += '<div class="cl-card" style="text-align:center;color:#64748B">Aucune mission planifi\u00e9e pour le moment.</div>';
      renderCleanerScreen(html);
      return;
    }

    var todayMissions = cleanerMissions.filter(function (m) { return m.date === todayStr; });
    var futureMissions = cleanerMissions.filter(function (m) { return m.date > todayStr; });
    var pastMissions = cleanerMissions.filter(function (m) { return m.date < todayStr; });

    html += '<div class="cl-section-title">Aujourd\u2019hui</div>';
    html += todayMissions.length ? todayMissions.map(makeMissionCard).join('') :
      '<p style="color:#94A3B8;font-size:13px;margin-bottom:12px">Aucune mission aujourd\u2019hui.</p>';

    if (futureMissions.length) {
      html += '<div class="cl-section-title">\u00c0 venir</div>';
      html += futureMissions.map(makeMissionCard).join('');
    }
    if (pastMissions.length) {
      html += '<div class="cl-section-title">Termin\u00e9es r\u00e9cemment</div>';
      html += pastMissions.slice(-5).reverse().map(makeMissionCard).join('');
    }

    renderCleanerScreen(html);
  }

  function makeMissionCard(m) {
    var apt = aptOf(m);
    var nomLogement = apt ? apt.name : 'Logement non assign\u00e9';
    var emoji = (apt && apt.emoji) || '\uD83C\uDFE0';
    var dateFormatted = m.date ? new Date(m.date).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }) : '\u2014';
    var duree = (m.duree_min != null && m.duree_min !== '') ? (m.duree_min + ' min') : '\u2014';
    var tarif = (m.tarif != null && m.tarif !== '') ? (m.tarif + ' \u20AC') : '\u2014';

    return (
      '<div class="cl-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:10px">' +
          '<div style="font-weight:800;font-size:16px;color:#0B0722;flex:1">' + emoji + ' ' + esc(nomLogement) + '</div>' +
          '<div>' + statusBadge(m.status) + '</div>' +
        '</div>' +
        '<div style="font-size:13px;color:#475569;margin-bottom:4px">\uD83D\uDCC5 ' + dateFormatted + ' \u2014 ' + esc(m.heure || 'Horaire flexible') + '</div>' +
        '<div style="font-size:13px;color:#475569;margin-bottom:12px">\u23F1\uFE0F ' + duree + ' \u00b7 \uD83D\uDCB0 ' + tarif + '</div>' +
        '<button class="cl-btn cl-btn-primary" style="padding:12px;font-size:14px" onclick="RQCleaner.viewMission(\'' + m.id + '\')">Voir la mission</button>' +
      '</div>'
    );
  }

  // ── Écran 2 : détail mission ──
  function viewMissionDetails(missionId) {
    var m = cleanerMissions.find(function (x) { return String(x.id) === String(missionId); });
    if (!m) return;
    selectedMissionId = missionId;
    var apt = aptOf(m) || {};

    var actionHtml = '';
    if (!m.status || m.status === 'en_attente' || m.status === 'acceptee') {
      actionHtml = '<button class="cl-btn cl-btn-primary" onclick="RQCleaner.startMission()">\u25B6\uFE0F D\u00c9MARRER LE M\u00c9NAGE</button>';
    } else if (m.status === 'en_cours') {
      var startedTime = m.started_at ? new Date(m.started_at).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '--h--';
      actionHtml =
        '<div style="background:#EFF6FF;border:1px solid #BFDBFE;border-radius:12px;padding:12px;text-align:center;margin-bottom:12px;font-weight:700;color:#1E40AF">' +
          '\u23F1\uFE0F M\u00e9nage d\u00e9marr\u00e9 \u00e0 ' + startedTime +
        '</div>' +
        '<button class="cl-btn cl-btn-success" onclick="RQCleaner.goToCompletionForm()">\uD83C\uDFC1 TERMINER LE M\u00c9NAGE</button>';
    } else if (m.status === 'terminee') {
      actionHtml = '<div class="cl-badge cl-badge-done" style="width:100%;text-align:center;padding:14px">\u2713 Mission termin\u00e9e</div>';
    } else if (m.status === 'probleme') {
      actionHtml = '<div class="cl-badge cl-badge-problem" style="width:100%;text-align:center;padding:14px">\u26A0 Incident signal\u00e9</div>';
    }

    var html =
      '<button class="cl-btn cl-btn-secondary" style="padding:10px;font-size:13px;width:auto;margin-bottom:16px" onclick="RQCleaner.backToList()">\u2190 Retour</button>' +
      '<h2 class="cl-title">' + esc(apt.name || 'D\u00e9tails mission') + '</h2>' +
      '<div class="cl-card">' +
        '<div class="cl-section-title" style="margin-top:0">\uD83D\uDCCD Informations cl\u00e9s</div>' +
        '<p style="margin-bottom:8px"><strong>Adresse :</strong> ' + esc(apt.address || 'Non renseign\u00e9e') + (apt.city ? ', ' + esc(apt.city) : '') + '</p>' +
        '<p style="margin-bottom:8px"><strong>Code porte :</strong> ' + codeChip(apt.code_porte) + '</p>' +
        '<p style="margin-bottom:8px"><strong>Bo\u00eete \u00e0 cl\u00e9s :</strong> ' + codeChip(apt.code_boite_cles) + '</p>' +
        '<p style="margin-bottom:0"><strong>Wifi :</strong> ' + codeChip(apt.wifi_code) + '</p>' +
      '</div>' +
      '<div class="cl-card">' +
        '<div class="cl-section-title" style="margin-top:0">\uD83D\uDCDD Consignes</div>' +
        '<p style="margin-bottom:0;line-height:1.5;white-space:pre-line">' + esc(apt.consignes_cleaner || m.notes || 'Aucune consigne sp\u00e9cifique.') + '</p>' +
      '</div>' +
      '<div style="margin-top:20px">' + actionHtml + '</div>';

    renderCleanerScreen(html);
  }

  function codeChip(val) {
    if (!val) return '<span style="color:#94A3B8">Non renseign\u00e9</span>';
    return '<span style="background:#F1F5F9;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:15px">' + esc(val) + '</span>';
  }

  // ── Action : démarrer ──
  async function startMission() {
    if (!selectedMissionId) return;
    try {
      var data = await callPortal({ action: 'startMission', missionId: selectedMissionId });
      if (data && data.mission) updateLocalMission(data.mission);
      viewMissionDetails(selectedMissionId);
    } catch (e) {
      alert('Erreur lors du d\u00e9marrage. V\u00e9rifiez votre connexion.');
    }
  }

  function updateLocalMission(updated) {
    var idx = cleanerMissions.findIndex(function (m) { return String(m.id) === String(updated.id); });
    if (idx !== -1) cleanerMissions[idx] = updated;
  }

  // ── Écran 3 : choix fin de mission ──
  function goToCompletionForm() {
    uploadedPhotoUrls = [];
    var html =
      '<button class="cl-btn cl-btn-secondary" style="padding:10px;font-size:13px;width:auto;margin-bottom:16px" onclick="RQCleaner.viewMission(\'' + selectedMissionId + '\')">\u2190 Annuler</button>' +
      '<h2 class="cl-title">Fin de mission</h2>' +
      '<div class="cl-card" style="text-align:center;padding:24px">' +
        '<p style="font-size:18px;font-weight:700;margin-bottom:20px">Tout est conforme dans le logement ?</p>' +
        '<button class="cl-btn cl-btn-success" style="margin-bottom:16px" onclick="RQCleaner.goToSubmitOk()">\uD83D\uDFE2 Oui, tout est OK</button>' +
        '<button class="cl-btn cl-btn-danger" onclick="RQCleaner.goToSubmitProblem()">\uD83D\uDD34 Signaler un probl\u00e8me</button>' +
      '</div>';
    renderCleanerScreen(html);
  }

  // ── Écran succès : photo obligatoire ──
  function goToSubmitOk() {
    var html =
      '<button class="cl-btn cl-btn-secondary" style="padding:10px;font-size:13px;width:auto;margin-bottom:16px" onclick="RQCleaner.goToCompletionForm()">\u2190 Retour</button>' +
      '<h2 class="cl-title">Validation du m\u00e9nage</h2>' +
      '<div class="cl-card">' +
        '<div class="cl-section-title" style="margin-top:0">\uD83D\uDCF8 Photo finale obligatoire</div>' +
        '<p style="color:#64748B;margin-bottom:14px;font-size:13px">Ajoutez au moins 1 photo globale du logement propre pour valider votre intervention.</p>' +
        '<div class="cl-photo-placeholder" id="upload-zone">' +
          '<span>\uD83D\uDCF7 Prendre / s\u00e9lectionner une photo</span>' +
          '<input type="file" accept="image/*" onchange="RQCleaner.handlePhotoUpload(this,\'cleaning-completions\')">' +
        '</div>' +
        '<div id="photo-preview-list" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"></div>' +
      '</div>' +
      '<button class="cl-btn cl-btn-success" id="btn-submit-final" disabled onclick="RQCleaner.submitSuccess()">\u2713 VALIDER ET CL\u00d4TURER</button>';
    renderCleanerScreen(html);
  }

  // ── Écran problème ──
  function goToSubmitProblem() {
    var html =
      '<button class="cl-btn cl-btn-secondary" style="padding:10px;font-size:13px;width:auto;margin-bottom:16px" onclick="RQCleaner.goToCompletionForm()">\u2190 Retour</button>' +
      '<h2 class="cl-title">Signalement d\u2019un incident</h2>' +
      '<div class="cl-card">' +
        '<div class="cl-section-title" style="margin-top:0">\u26A0\uFE0F Type d\u2019anomalie</div>' +
        '<select id="report-type" style="width:100%;padding:14px;border-radius:10px;border:1px solid #CBD5E1;margin-bottom:16px;font-size:14px;font-weight:600">' +
          '<option value="casse">Objets cass\u00e9s / vaisselle</option>' +
          '<option value="degradation">D\u00e9gradation murs / mobilier</option>' +
          '<option value="maintenance">Probl\u00e8me technique / maintenance</option>' +
          '<option value="consommable_manquant">Manque de consommables essentiels</option>' +
          '<option value="logement_tres_sale">Logement anormalement sale</option>' +
          '<option value="odeur_tabac">Odeur persistante de tabac</option>' +
          '<option value="autre">Autre incident</option>' +
        '</select>' +
        '<div class="cl-section-title">\uD83D\uDCAC Commentaire</div>' +
        '<textarea id="report-comment" placeholder="D\u00e9crivez la situation..." style="width:100%;height:100px;padding:12px;border-radius:10px;border:1px solid #CBD5E1;font-family:inherit;margin-bottom:16px"></textarea>' +
        '<div class="cl-section-title">\uD83D\uDCF8 Photo du probl\u00e8me obligatoire</div>' +
        '<div class="cl-photo-placeholder" id="upload-zone">' +
          '<span>\uD83D\uDCF7 Prendre la photo du probl\u00e8me</span>' +
          '<input type="file" accept="image/*" onchange="RQCleaner.handlePhotoUpload(this,\'cleaning-reports\')">' +
        '</div>' +
        '<div id="photo-preview-list" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap"></div>' +
      '</div>' +
      '<button class="cl-btn cl-btn-danger" id="btn-submit-final" disabled onclick="RQCleaner.submitProblem()">\u26A0\uFE0F ENVOYER LE RAPPORT</button>';
    renderCleanerScreen(html);
  }

  // ── Upload photo via la Function (multipart), jamais directement vers Supabase ──
  async function handlePhotoUpload(inputEl, bucket) {
    var file = inputEl.files[0];
    if (!file) return;

    var zone = document.getElementById('upload-zone');
    var originalHtml = zone ? zone.innerHTML : '';
    if (zone) { zone.style.opacity = '0.5'; zone.innerHTML = '<span>\u23F3 T\u00e9l\u00e9chargement en cours...</span>'; }

    try {
      var form = new FormData();
      form.append('token', token);
      form.append('bucket', bucket);
      form.append('file', file);

      var res = await fetch('/api/cleaner-portal', { method: 'POST', body: form });
      var data = await res.json();
      if (!res.ok || !data.url) throw new Error('upload_failed');

      uploadedPhotoUrls.push(data.url);

      var previewList = document.getElementById('photo-preview-list');
      if (previewList) {
        previewList.innerHTML += '<div style="position:relative;width:70px;height:70px;border-radius:8px;overflow:hidden;border:1px solid #CBD5E1"><img src="' + esc(data.url) + '" style="width:100%;height:100%;object-fit:cover"></div>';
      }
      var btn = document.getElementById('btn-submit-final');
      if (btn) btn.removeAttribute('disabled');
    } catch (err) {
      alert('Erreur de transfert de la photo. Veuillez r\u00e9essayer.');
    } finally {
      if (zone) { zone.style.opacity = '1'; zone.innerHTML = originalHtml; }
    }
  }

  // ── Soumission succès ──
  async function submitSuccess() {
    try {
      var data = await callPortal({ action: 'completeMission', missionId: selectedMissionId, photos: uploadedPhotoUrls });
      if (data && data.mission) updateLocalMission(data.mission);
      alert('\uD83C\uDF89 Mission valid\u00e9e avec succ\u00e8s ! Merci pour votre travail.');
      renderMissionsList();
    } catch (e) {
      alert('Erreur de transmission.');
    }
  }

  // ── Soumission problème ──
  async function submitProblem() {
    var reportType = document.getElementById('report-type').value;
    var comment = document.getElementById('report-comment').value;
    try {
      await callPortal({ action: 'reportProblem', missionId: selectedMissionId, reportType: reportType, comment: comment, photos: uploadedPhotoUrls });
      alert('\u26A0\uFE0F Rapport d\u2019incident envoy\u00e9 \u00e0 votre responsable.');
      renderMissionsList();
    } catch (e) {
      alert('Erreur lors de la transmission du rapport.');
    }
  }

  // ── API publique minimale exposée aux onclick inline (pas de pollution du scope global) ──
  window.RQCleaner = {
    viewMission: viewMissionDetails,
    backToList: renderMissionsList,
    startMission: startMission,
    goToCompletionForm: goToCompletionForm,
    goToSubmitOk: goToSubmitOk,
    goToSubmitProblem: goToSubmitProblem,
    handlePhotoUpload: handlePhotoUpload,
    submitSuccess: submitSuccess,
    submitProblem: submitProblem
  };
})();
