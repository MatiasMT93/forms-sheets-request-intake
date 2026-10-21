const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Sheet {
  constructor(name) { this.name = name; this.rows = []; this.failNextAppend = false; }
  getLastRow() { return this.rows.length; }
  setFrozenRows() { return this; }
  appendRow(row) {
    if (this.failNextAppend) { this.failNextAppend = false; throw new Error('Fallo de prueba'); }
    this.rows.push(row.slice()); return this;
  }
  getDataRange() { return { getValues: () => this.rows.map(row => row.slice()) }; }
  getRange(row, col, height = 1, width = 1) {
    const self = this;
    return {
      getValue() { return (self.rows[row - 1] || [])[col - 1] ?? ''; },
      setValue(value) {
        if (!self.rows[row - 1]) self.rows[row - 1] = [];
        self.rows[row - 1][col - 1] = value;
        return this;
      },
      getValues() {
        return Array.from({ length: height }, (_, rr) =>
          Array.from({ length: width }, (_, cc) =>
            (self.rows[row + rr - 1] || [])[col + cc - 1] ?? ''));
      }
    };
  }
}
class Spreadsheet {
  constructor() { this.sheets = new Map(); }
  insertSheet(name) { const s = new Sheet(name); this.sheets.set(name, s); return s; }
  getSheetByName(name) { return this.sheets.get(name) || null; }
}

function environment() {
  const spreadsheet = new Spreadsheet();
  const sent = [], triggers = [], errors = [];
  const state = { locked: false, failMail: false, afterMailSend: null, properties: { ALERT_EMAIL: 'responsable@example.com' } };
  const scriptLock = {
    waitLock() { if (state.locked) throw new Error('El bloqueo no está disponible'); state.locked = true; },
    releaseLock() { state.locked = false; }
  };
  function triggerBuilder(fn) {
    return {
      forSpreadsheet() { return this; },
      onFormSubmit() { return this; },
      timeBased() { return this; },
      everyMinutes(minutes) { assert.equal(minutes, 5); return this; },
      create() { triggers.push({ getHandlerFunction: () => fn }); return this; }
    };
  }
  const context = vm.createContext({
    Date, console: { log() {}, error: (...args) => errors.push(args.join(' ')) },
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {} },
    LockService: { getScriptLock: () => scriptLock },
    ScriptApp: { getProjectTriggers: () => triggers, newTrigger: triggerBuilder },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => state.properties[key] }) },
    MailApp: { sendEmail(to, subject, body) { if (state.failMail) throw new Error('Servicio inactivo'); sent.push({ to, subject, body }); if (state.afterMailSend) { const hook = state.afterMailSend; state.afterMailSend = null; hook(); } } }
  });
  const root = path.resolve(__dirname, '..');
  for (const file of ['Domain.gs', 'Code.gs']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'src', file), 'utf8'), context, { filename: file });
  }
  function call(expression, ...args) {
    // Ejecuta en el contexto simulado y pasa los argumentos mediante una variable temporal.
    context.__testArgs = args;
    try { return vm.runInContext(`${expression}(...__testArgs)`, context); }
    finally { delete context.__testArgs; }
  }
  function sheet(name) { return spreadsheet.getSheetByName(name); }
  function event(overrides = {}, row = 2) {
    const fields = {
      'ID solicitud': ['SOL-0001'],
      'Nombre': ['Ana Prueba'],
      'Correo': ['ana@example.com'],
      'Tipo de consulta': ['Inscripción'],
      'Detalle': ['Consulta de horarios'],
      ...overrides
    };
    return { namedValues: fields, source: spreadsheet, range: { getRow: () => row } };
  }
  return { spreadsheet, state, sent, triggers, errors, call, sheet, event };
}
function setup() { const e = environment(); e.call('initializeP001'); return e; }

test('T01 - registra la solicitud válida y la deja pendiente', () => {
  const e = setup();
  assert.equal(e.call('handleFormSubmit', e.event()).status, 'REGISTRADA');
  const r = e.sheet('Solicitudes').rows;
  assert.equal(r.length, 2);
  assert.equal(r[1][0], 'SOL-0001');
  assert.equal(r[1][7], 'PENDIENTE');
  assert.equal(e.sheet('Bitacora').rows[1][2], 'REGISTRADA');
});

test('T01b - acepta espacios al inicio del encabezado', () => {
  const e = setup();
  const ev = e.event();
  ev.namedValues['  Detalle'] = ev.namedValues['Detalle'];
  delete ev.namedValues['Detalle'];
  assert.equal(e.call('handleFormSubmit', ev).status, 'REGISTRADA');
  assert.equal(e.sheet('Solicitudes').rows[1][4], 'Consulta de horarios');
});

test('Rechaza encabezados ambiguos después de quitar espacios', () => {
  const e = setup();
  const ev = e.event({ '  Detalle': ['Otro texto'] });
  const result = e.call('handleFormSubmit', ev);
  assert.equal(result.status, 'INVALIDA');
  assert.ok(result.errors.includes('DETALLE_INVALIDO'));
});

test('T02 - rechaza un campo obligatorio vacío', () => {
  const e = setup();
  const result = e.call('handleFormSubmit', e.event({ 'Nombre': [''] }));
  assert.equal(result.status, 'INVALIDA');
  assert.ok(result.errors.includes('NOMBRE_INVALIDO'));
  assert.equal(e.sheet('Solicitudes').rows.length, 1);
  assert.equal(e.sheet('Bitacora').rows[1][2], 'INVALIDA');
});

test('T03 - rechaza un correo inválido', () => {
  const e = setup();
  assert.equal(e.call('handleFormSubmit', e.event({ 'Correo': ['sin-arroba'] })).status, 'INVALIDA');
});

test('T04 - no procesa dos veces un mismo identificador', () => {
  const e = setup();
  e.call('handleFormSubmit', e.event());
  assert.equal(e.call('handleFormSubmit', e.event({}, 3)).status, 'DUPLICADA');
  assert.equal(e.sheet('Solicitudes').rows.length, 2);
  assert.equal(e.sheet('Bitacora').rows.at(-1)[2], 'DUPLICADA');
});

test('T05 - procesa solicitudes con ID diferentes', () => {
  const e = setup();
  e.call('handleFormSubmit', e.event());
  e.call('handleFormSubmit', e.event({ 'ID solicitud': ['SOL-0002'] }, 3));
  assert.equal(e.sheet('Solicitudes').rows.length, 3);
});

test('T06 - el bloqueo evita escrituras sin protección (simulado)', () => {
  const e = setup();
  e.state.locked = true;
  assert.throws(() => e.call('handleFormSubmit', e.event()), /bloqueo/);
  e.state.locked = false;
  assert.equal(e.call('handleFormSubmit', e.event()).status, 'REGISTRADA');
  assert.equal(e.call('handleFormSubmit', e.event()).status, 'DUPLICADA');
  assert.equal(e.sheet('Solicitudes').rows.length, 2);
});

test('T07 - falla el correo y deja el registro en revisión', () => {
  const e = setup();
  e.call('handleFormSubmit', e.event());
  e.state.failMail = true;
  e.call('processPendingNotifications');
  assert.equal(e.sheet('Solicitudes').rows[1][7], 'REVISION');
  e.state.failMail = false;
  e.call('processPendingNotifications');
  assert.equal(e.sent.length, 0);
  assert.equal(e.sheet('Solicitudes').rows[1][8], 1);
});

test('T08 - reprocesar el evento no duplica registros', () => {
  const e = setup();
  const ev = e.event();
  e.call('handleFormSubmit', ev);
  e.call('handleFormSubmit', ev);
  assert.equal(e.sheet('Solicitudes').rows.length, 2);
});

test('T09 - protege el texto que parece una fórmula', () => {
  const e = setup();
  e.call('handleFormSubmit', e.event({ 'Nombre': ['=SUM(1,2)'], 'Detalle': ['+IMPORTXML(1)'] }));
  assert.equal(e.sheet('Solicitudes').rows[1][1], "'=SUM(1,2)");
  assert.equal(e.sheet('Solicitudes').rows[1][4], "'+IMPORTXML(1)");
});

test('T10 - un envío interrumpido requiere revisión', () => {
  const e = setup();
  e.call('handleFormSubmit', e.event());
  const row = e.sheet('Solicitudes').rows[1];
  row[7] = 'ENVIANDO'; row[9] = new Date(Date.now() - 21 * 60000);
  e.call('processPendingNotifications');
  assert.equal(row[7], 'REVISION');
  assert.equal(e.sent.length, 0);
});

test('T12 - el aviso no expone datos personales', () => {
  const e = setup();
  e.call('handleFormSubmit', e.event());
  e.call('processPendingNotifications');
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].to, 'responsable@example.com');
  assert.equal(e.sent[0].body.includes('ana@example.com'), false);
  assert.equal(e.sent[0].body.includes('Ana Prueba'), false);
  assert.equal(e.sheet('Solicitudes').rows[1][7], 'ENVIADA');
});

test('La inicialización no duplica activadores y valida ALERT_EMAIL', () => {
  const e = setup();
  e.call('initializeP001');
  assert.equal(e.triggers.length, 2);
  e.state.properties.ALERT_EMAIL = '';
  assert.throws(() => e.call('initializeP001'), /ALERT_EMAIL/);
});

test('Rechaza encabezados inesperados sin sobrescribir datos', () => {
  const e = setup();
  e.sheet('Solicitudes').rows[0][0] = 'INCORRECTO';
  assert.throws(() => e.call('initializeP001'), /Encabezados/);
});

test('Un fallo en la bitácora no elimina la solicitud registrada', () => {
  const e = setup();
  e.sheet('Bitacora').failNextAppend = true;
  assert.equal(e.call('handleFormSubmit', e.event()).status, 'REGISTRADA');
  assert.equal(e.sheet('Solicitudes').rows.length, 2);
  assert.ok(e.errors.some(msg => msg.includes('error al auditar')));
});

test('Rechaza un evento de formulario ausente', () => {
  const e = setup();
  assert.throws(() => e.call('handleFormSubmit'), /evento/);
});


test('T13 - si falla el cierre de un aviso, procesa el siguiente sin repetir el primero', () => {
  const e = setup();
  e.call('handleFormSubmit', e.event());
  e.call('handleFormSubmit', e.event({ 'ID solicitud': ['SOL-0002'] }, 3));
  // Simula que alguien modifica la primera fila justo después de enviar el correo.
  e.state.afterMailSend = () => {
    e.sheet('Solicitudes').rows[1][7] = 'MODIFICADA';
  };
  assert.doesNotThrow(() => e.call('processPendingNotifications'));
  assert.equal(e.sent.length, 2);
  assert.equal(e.sheet('Solicitudes').rows[1][7], 'MODIFICADA');
  assert.equal(e.sheet('Solicitudes').rows[2][7], 'ENVIADA');
  assert.ok(e.errors.some(msg => msg.includes('requiere revisión manual')));
});
