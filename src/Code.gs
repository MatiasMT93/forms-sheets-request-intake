/**
 * Puntos de entrada de Apps Script vinculados a una hoja de cálculo.
 * Requiere vincular Google Forms y autorizar los servicios de Google.
 * No almacena contraseñas ni tokens en el código fuente.
 */

/**
 * Ejecutar manualmente después de configurar ALERT_EMAIL y vincular el formulario.
 * Puede repetirse sin sobrescribir datos ni duplicar activadores.
 */
function initializeP001() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Abrí Apps Script desde la hoja de respuestas.');
  const alertEmail = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL');
  if (!alertEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alertEmail)) {
    throw new Error('Configurá ALERT_EMAIL en Propiedades del script antes de inicializar.');
  }

  p001EnsureSheet_(spreadsheet, P001_CONFIG.requestsSheet, P001_HEADERS);
  p001EnsureSheet_(spreadsheet, P001_CONFIG.auditSheet, P001_AUDIT_HEADERS);

  const triggers = ScriptApp.getProjectTriggers().map(function (trigger) {
    return trigger.getHandlerFunction();
  });
  if (triggers.indexOf('handleFormSubmit') === -1) {
    ScriptApp.newTrigger('handleFormSubmit').forSpreadsheet(spreadsheet).onFormSubmit().create();
  }
  if (triggers.indexOf('processPendingNotifications') === -1) {
    ScriptApp.newTrigger('processPendingNotifications').timeBased().everyMinutes(5).create();
  }
  console.log('P-001 inicializado; comprobá los activadores en Apps Script.');
}

function p001EnsureSheet_(ss, title, headers) {
  let sheet = ss.getSheetByName(title);
  if (!sheet) sheet = ss.insertSheet(title);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  } else {
    const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    if (headers.some(function (head, i) { return current[i] !== head; })) {
      throw new Error('Encabezados inesperados en ' + title + ': detené el despliegue.');
    }
  }
  return sheet;
}

/** Activador instalable de envío de formulario desde Sheets, no desde Forms. */
function handleFormSubmit(event) {
  if (!event || !event.namedValues || !event.source || !event.range) {
    throw new Error('Se requiere evento de envío de formulario DESDE Sheets.');
  }
  const data = p001FromNamedValues_(event.namedValues);
  const errors = p001Validate_(data);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const requests = p001GetSheet_(event.source, P001_CONFIG.requestsSheet);
    const existing = p001FindRequest_(requests.getDataRange().getValues(), data.id);
    if (errors.length) {
      p001Audit_(event.source, data.id, 'INVALIDA', errors.join(','));
      return { status: 'INVALIDA', errors: errors };
    }
    if (existing !== -1) {
      p001Audit_(event.source, data.id, 'DUPLICADA', 'La clave ya existe; no se volvió a procesar.');
      return { status: 'DUPLICADA' };
    }
    const now = new Date();
    requests.appendRow(p001RecordRow_(data, event.range.getRow(), now));
    SpreadsheetApp.flush();
    // La solicitud ya está guardada antes de intentar registrar el evento.
    try {
      p001Audit_(event.source, data.id, 'REGISTRADA', 'Notificación pendiente');
    } catch (auditError) {
      console.error('Registro realizado; error al auditar ' + data.id);
    }
    return { status: 'REGISTRADA' };
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/** Activador cada cinco minutos; procesa hasta diez avisos por ejecución. */
function processPendingNotifications() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Planificador debe ejecutarse en proyecto vinculado a Sheets.');
  p001RecoverStale_(ss);
  for (let i = 0; i < P001_CONFIG.notificationBatchSize; i++) {
    const item = p001ClaimNext_(ss);
    if (!item) break;
    try {
      const to = PropertiesService.getScriptProperties().getProperty('ALERT_EMAIL');
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('ALERT_EMAIL_INVALIDO');
      // El aviso no incluye nombre, correo ni detalle del solicitante.
      MailApp.sendEmail(to, 'P-001 | Nueva solicitud ' + item.id,
        'Hay una nueva solicitud de tipo ' + item.category + '.\nID: ' + item.id +
        '\nConsultá el archivo de Sheets para ver el registro.');
      p001FinishNotification_(ss, item, 'ENVIADA', '');
    } catch (err) {
      // El correo podría haberse enviado; no se reintenta automáticamente.
      try {
        p001FinishNotification_(ss, item, 'REVISION', 'Verificar envío antes de reintentar.');
      } catch (reviewError) {
        // Si cambió la fila, no se puede confirmar el estado. Continuar el lote.
        console.error('No se pudo actualizar la solicitud ' + item.id +
          '; requiere revisión manual.');
      }
      console.error('Envío requiere revisión para ' + item.id);
    }
  }
}

function p001ClaimNext_(ss) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = p001GetSheet_(ss, P001_CONFIG.requestsSheet);
    const rows = sheet.getDataRange().getValues();
    for (let row = 2; row <= rows.length; row++) {
      if (rows[row - 1][7] !== 'PENDIENTE') continue;
      sheet.getRange(row, 8).setValue('ENVIANDO');
      sheet.getRange(row, 9).setValue(Number(rows[row - 1][8]) + 1);
      sheet.getRange(row, 10).setValue(new Date().toISOString());
      SpreadsheetApp.flush();
      return { row: row, id: String(rows[row - 1][0]), category: String(rows[row - 1][3]) };
    }
    return null;
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function p001FinishNotification_(ss, item, status, errorCode) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = p001GetSheet_(ss, P001_CONFIG.requestsSheet);
    if (String(sheet.getRange(item.row, 1).getValue()) !== item.id ||
        sheet.getRange(item.row, 8).getValue() !== 'ENVIANDO') {
      throw new Error('El registro fue modificado durante el envío; revisión manual necesaria.');
    }
    sheet.getRange(item.row, 8).setValue(status);
    sheet.getRange(item.row, 10).setValue(new Date().toISOString());
    sheet.getRange(item.row, 11).setValue(errorCode);
    try { p001Audit_(ss, item.id, status, errorCode || 'Notificación procesada'); }
    catch (auditError) { console.error('Fallo al auditar notificación ' + item.id); }
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/** Detecta envíos interrumpidos sin reintentarlos automáticamente. */
function p001RecoverStale_(ss) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sheet = p001GetSheet_(ss, P001_CONFIG.requestsSheet);
    const rows = sheet.getDataRange().getValues();
    const cutoff = Date.now() - P001_CONFIG.staleMinutes * 60000;
    for (let row = 2; row <= rows.length; row++) {
      const values = rows[row - 1];
      if (values[7] !== 'ENVIANDO') continue;
      const last = values[9] instanceof Date ? values[9].getTime() : new Date(values[9]).getTime();
      if (Number.isFinite(last) && last > cutoff) continue;
      sheet.getRange(row, 8).setValue('REVISION');
      sheet.getRange(row, 10).setValue(new Date().toISOString());
      sheet.getRange(row, 11).setValue('Resultado del envío incierto; no se reintenta automáticamente');
      try { p001Audit_(ss, String(values[0]), 'REVISION', 'Ejecución interrumpida'); }
      catch (auditError) { console.error('No se pudo auditar interrupción.'); }
    }
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

function p001GetSheet_(ss, title) {
  const sheet = ss.getSheetByName(title);
  if (!sheet) throw new Error('Falta hoja ' + title + '. Ejecutá initializeP001().');
  return sheet;
}

function p001Audit_(ss, id, eventName, detail) {
  p001GetSheet_(ss, P001_CONFIG.auditSheet).appendRow([
    new Date().toISOString(), p001SafeCell_(id), eventName, p001SafeCell_(detail)
  ]);
}
