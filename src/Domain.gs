/**
 * Reglas de negocio independientes de los servicios de Google.
 * Se pueden probar localmente con Node.js.
 */
const P001_CONFIG = Object.freeze({
  requestsSheet: 'Solicitudes',
  auditSheet: 'Bitacora',
  fieldNames: Object.freeze({
    id: 'ID solicitud',
    name: 'Nombre',
    email: 'Correo',
    category: 'Tipo de consulta',
    detail: 'Detalle'
  }),
  categories: Object.freeze(['Inscripción', 'Consulta general', 'Información de cursos']),
  notificationBatchSize: 10,
  staleMinutes: 20
});

const P001_HEADERS = Object.freeze([
  'ID_SOLICITUD', 'NOMBRE', 'CORREO', 'TIPO', 'DETALLE',
  'RECIBIDO_UTC', 'FILA_ORIGEN', 'NOTIFICACION',
  'INTENTOS', 'ACTUALIZADO_UTC', 'ULTIMO_ERROR'
]);
const P001_AUDIT_HEADERS = Object.freeze(['FECHA_UTC', 'ID_SOLICITUD', 'EVENTO', 'DETALLE']);

function p001Text_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

function p001FromNamedValues_(namedValues) {
  const fields = P001_CONFIG.fieldNames;
  function field(key) {
    // Google Sheets puede conservar espacios adicionales en los encabezados.
    // Se eliminan espacios externos; si hay ambigüedad, se rechaza el campo.
    const matches = Object.keys(namedValues || {}).filter(function (actualName) {
      return actualName.trim() === fields[key];
    });
    if (matches.length !== 1) return '';
    const raw = namedValues[matches[0]];
    return p001Text_(Array.isArray(raw) ? raw[0] : raw);
  }
  return {
    id: field('id').toUpperCase(),
    name: field('name'),
    email: field('email').toLowerCase(),
    category: field('category'),
    detail: field('detail')
  };
}

function p001Validate_(data) {
  const errors = [];
  if (!/^SOL-[A-Z0-9]{4,12}$/.test(data.id)) errors.push('ID_FORMATO');
  if (data.name.length < 2 || data.name.length > 80) errors.push('NOMBRE_INVALIDO');
  if (data.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errors.push('CORREO_INVALIDO');
  if (P001_CONFIG.categories.indexOf(data.category) === -1) errors.push('TIPO_INVALIDO');
  if (data.detail.length < 2 || data.detail.length > 500) errors.push('DETALLE_INVALIDO');
  return errors;
}

/** Evita que el texto recibido se interprete como una fórmula de Sheets. */
function p001SafeCell_(value) {
  const text = p001Text_(value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function p001RecordRow_(data, sourceRow, now) {
  return [
    p001SafeCell_(data.id), p001SafeCell_(data.name), p001SafeCell_(data.email),
    p001SafeCell_(data.category), p001SafeCell_(data.detail),
    now.toISOString(), Number(sourceRow) || '', 'PENDIENTE', 0, now.toISOString(), ''
  ];
}

function p001FindRequest_(rows, id) {
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === id) return i + 1; // número de fila de Sheets (comienza en 1)
  }
  return -1;
}
