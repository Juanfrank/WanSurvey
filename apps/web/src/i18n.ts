import { rendererResources } from '@wansurvey/renderer';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { casesEn, casesEs } from './cases/i18n.js';
import { interviewEn, interviewEs } from './interview/i18n.js';
import { designerEn, designerEs } from './designer/i18n.js';
import { messagesEn, messagesEs } from './messages-i18n.js';

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
] as const;

const en = {
  app: {
    name: 'WanSurvey',
    language: 'Language',
    signOut: 'Sign out',
    organisation: 'Organisation',
    home: 'Home',
    preview: 'Questionnaire preview',
    projects: 'Projects',
    skip: 'Skip to content',
  },
  login: {
    title: 'Sign in',
    email: 'E-mail',
    password: 'Password',
    submit: 'Sign in',
    or: 'or',
    microsoft: 'Sign in with Microsoft',
    microsoftNeedsEmail: 'Enter your work e-mail first, so we can find your organisation.',
    errors: {
      INVALID_CREDENTIALS: 'The e-mail or password is not correct.',
      SSO_REQUIRED: 'Your organisation requires signing in with Microsoft.',
      NOT_A_MEMBER: 'You are not a member of that organisation.',
      generic: 'Sign-in failed. Please try again.',
    },
    sso: {
      sso_not_configured: 'Microsoft sign-in is not set up for your organisation.',
      choose_organisation:
        'Several organisations use this e-mail domain; contact your administrator.',
      invalid_state: 'The sign-in took too long or was interrupted. Please try again.',
      microsoft_error: 'Microsoft did not complete the sign-in.',
      token_exchange_failed: 'We could not confirm the sign-in with Microsoft. Please try again.',
      invalid_token: 'The sign-in from Microsoft could not be verified.',
      domain_not_allowed: 'Your e-mail domain is not allowed for this organisation.',
      account_disabled: 'This account is disabled.',
      membership_deactivated: 'Your access to this organisation has been removed.',
      generic: 'Microsoft sign-in failed.',
    },
  },
  twofa: {
    title: 'Two-factor authentication',
    prompt: 'Enter the 6-digit code from your authenticator app.',
    code: 'Code',
    verify: 'Verify',
    invalid: 'That code is not valid. Try the current one.',
    setupTitle: 'Set up two-factor authentication',
    setupIntro:
      'Your role requires a second factor. Add this key to an authenticator app (Microsoft Authenticator, Google Authenticator, 1Password…), then enter the code it shows.',
    secret: 'Setup key',
    openApp: 'Open in authenticator app',
    enable: 'Turn on',
  },
  home: {
    welcome: 'Welcome, {{name}}',
    intro: 'Use the questionnaire preview to test routing, wording and validation in every mode.',
    openPreview: 'Open the preview',
    projects: 'Projects',
    noProjects: 'No projects yet.',
  },
  waiting: {
    title: 'Waiting for access',
    explain: 'You can sign in, but you cannot work here until an administrator gives you a role.',
    otherOrgs: 'You also belong to:',
    switch: 'Switch',
  },
  preview: {
    title: 'Questionnaire preview',
    source: 'Questionnaire',
    sample: 'Sample',
    openFile: 'Open JSON file',
    paste: 'Paste JSON',
    load: 'Load',
    invalidJson: 'This is not valid JSON: {{error}}',
    schemaErrors: 'The questionnaire does not match the format:',
    diagnostics: 'Checks',
    errorsCount_one: '{{count}} error blocks publishing',
    errorsCount_other: '{{count}} errors block publishing',
    warningsCount_one: '{{count}} warning',
    warningsCount_other: '{{count}} warnings',
    noIssues: 'No problems found.',
    mode: 'Mode',
    language: 'Questionnaire language',
    today: 'Today is',
    context: 'Test case data (JSON)',
    contextHelp:
      'Sample data, respondent and interviewer used by pipes and logic: {"case": {…}, "respondent": {…}, "interviewer": {…}}',
    quotasFull: 'Quota cells treated as full',
    reset: 'Restart interview',
    tabs: { interview: 'Interview', compare: 'Compare modes', answers: 'Answers' },
    tracer: 'Path tracer',
    tracerHelp: 'Why each item is shown or skipped. Select an answered item to jump back to it.',
    status: {
      active: 'shown',
      hidden: 'hidden',
      skipped: 'skipped',
      notInMode: 'not in this mode',
      ended: 'after end',
    },
    current: 'current',
    compareHelp:
      'The current item in each interviewer and respondent mode. Wording that differs from the base text is marked.',
    differs: 'differs from base',
    base: 'base',
    hiddenInMode: 'Not shown in this mode',
    noAnswers: 'No answers yet.',
    scenarios: 'Test scenarios',
    scenariosHelp:
      'Save this run (answers and resulting path) and re-run it after changes; slice 4 runs them on every publish.',
    scenarioName: 'Scenario name',
    saveScenario: 'Save current run',
    runAll: 'Run all',
    run: 'Run',
    download: 'Download',
    upload: 'Load scenario file',
    remove: 'Delete',
    passed: 'passed',
    failed: 'failed',
    noScenarios: 'No saved scenarios for this questionnaire.',
    printPaper: 'Print the paper form',
  },
  designer: designerEn,
  cases: casesEn,
  interview: interviewEn,
  ...messagesEn,
};

type Catalogue = typeof en;

const es: Catalogue = {
  app: {
    name: 'WanSurvey',
    language: 'Idioma',
    signOut: 'Cerrar sesión',
    organisation: 'Organización',
    home: 'Inicio',
    preview: 'Vista previa del cuestionario',
    projects: 'Proyectos',
    skip: 'Ir al contenido',
  },
  login: {
    title: 'Iniciar sesión',
    email: 'Correo electrónico',
    password: 'Contraseña',
    submit: 'Ingresar',
    or: 'o',
    microsoft: 'Ingresar con Microsoft',
    microsoftNeedsEmail: 'Escriba primero su correo de trabajo para encontrar su organización.',
    errors: {
      INVALID_CREDENTIALS: 'El correo o la contraseña no son correctos.',
      SSO_REQUIRED: 'Su organización exige ingresar con Microsoft.',
      NOT_A_MEMBER: 'No es miembro de esa organización.',
      generic: 'No se pudo iniciar sesión. Intente de nuevo.',
    },
    sso: {
      sso_not_configured: 'El ingreso con Microsoft no está configurado para su organización.',
      choose_organisation:
        'Varias organizaciones usan este dominio de correo; contacte a su administrador.',
      invalid_state: 'El ingreso tardó demasiado o se interrumpió. Intente de nuevo.',
      microsoft_error: 'Microsoft no completó el ingreso.',
      token_exchange_failed: 'No pudimos confirmar el ingreso con Microsoft. Intente de nuevo.',
      invalid_token: 'No se pudo verificar el ingreso de Microsoft.',
      domain_not_allowed: 'El dominio de su correo no está permitido en esta organización.',
      account_disabled: 'Esta cuenta está deshabilitada.',
      membership_deactivated: 'Se retiró su acceso a esta organización.',
      generic: 'Falló el ingreso con Microsoft.',
    },
  },
  twofa: {
    title: 'Verificación en dos pasos',
    prompt: 'Ingrese el código de 6 dígitos de su aplicación de autenticación.',
    code: 'Código',
    verify: 'Verificar',
    invalid: 'Ese código no es válido. Use el actual.',
    setupTitle: 'Configurar la verificación en dos pasos',
    setupIntro:
      'Su rol requiere un segundo factor. Agregue esta clave a una aplicación de autenticación (Microsoft Authenticator, Google Authenticator, 1Password…) e ingrese el código que muestre.',
    secret: 'Clave de configuración',
    openApp: 'Abrir en la aplicación de autenticación',
    enable: 'Activar',
  },
  home: {
    welcome: 'Bienvenido/a, {{name}}',
    intro:
      'Use la vista previa del cuestionario para probar flujos, textos y validaciones en cada modo.',
    openPreview: 'Abrir la vista previa',
    projects: 'Proyectos',
    noProjects: 'Aún no hay proyectos.',
  },
  waiting: {
    title: 'Esperando acceso',
    explain:
      'Puede iniciar sesión, pero no podrá trabajar aquí hasta que un administrador le asigne un rol.',
    otherOrgs: 'También pertenece a:',
    switch: 'Cambiar',
  },
  preview: {
    title: 'Vista previa del cuestionario',
    source: 'Cuestionario',
    sample: 'Ejemplo',
    openFile: 'Abrir archivo JSON',
    paste: 'Pegar JSON',
    load: 'Cargar',
    invalidJson: 'No es un JSON válido: {{error}}',
    schemaErrors: 'El cuestionario no cumple el formato:',
    diagnostics: 'Verificaciones',
    errorsCount_one: '{{count}} error impide publicar',
    errorsCount_other: '{{count}} errores impiden publicar',
    warningsCount_one: '{{count}} advertencia',
    warningsCount_other: '{{count}} advertencias',
    noIssues: 'No se encontraron problemas.',
    mode: 'Modo',
    language: 'Idioma del cuestionario',
    today: 'Hoy es',
    context: 'Datos del caso de prueba (JSON)',
    contextHelp:
      'Datos de muestra, encuestado y entrevistador usados por los textos variables y la lógica: {"case": {…}, "respondent": {…}, "interviewer": {…}}',
    quotasFull: 'Celdas de cuota tratadas como llenas',
    reset: 'Reiniciar entrevista',
    tabs: { interview: 'Entrevista', compare: 'Comparar modos', answers: 'Respuestas' },
    tracer: 'Rastreador de flujo',
    tracerHelp:
      'Por qué cada ítem se muestra o se salta. Seleccione un ítem respondido para volver a él.',
    status: {
      active: 'mostrado',
      hidden: 'oculto',
      skipped: 'saltado',
      notInMode: 'no en este modo',
      ended: 'después del fin',
    },
    current: 'actual',
    compareHelp: 'El ítem actual en cada modo. Se marcan los textos distintos del texto base.',
    differs: 'distinto del base',
    base: 'base',
    hiddenInMode: 'No se muestra en este modo',
    noAnswers: 'Aún no hay respuestas.',
    scenarios: 'Escenarios de prueba',
    scenariosHelp:
      'Guarde esta ejecución (respuestas y flujo resultante) y vuelva a ejecutarla tras los cambios; la etapa 4 los ejecuta en cada publicación.',
    scenarioName: 'Nombre del escenario',
    saveScenario: 'Guardar ejecución actual',
    runAll: 'Ejecutar todos',
    run: 'Ejecutar',
    download: 'Descargar',
    upload: 'Cargar archivo de escenario',
    remove: 'Eliminar',
    passed: 'aprobado',
    failed: 'fallido',
    noScenarios: 'No hay escenarios guardados para este cuestionario.',
    printPaper: 'Imprimir el formulario en papel',
  },
  designer: designerEs,
  cases: casesEs,
  interview: interviewEs,
  ...messagesEs,
};

/** The interface is in Spanish unless the person picks another language (remembered). */
export function initI18n(lng = 'es') {
  const saved = (() => {
    try {
      return localStorage.getItem('ws.lang');
    } catch {
      return null;
    }
  })();
  if (typeof document !== 'undefined') document.documentElement.lang = saved ?? lng;
  return i18next.use(initReactI18next).init({
    lng: saved ?? lng,
    fallbackLng: 'es',
    supportedLngs: LANGUAGES.map((l) => l.code),
    defaultNS: 'app',
    ns: ['app', 'renderer'],
    resources: {
      en: { app: en, ...rendererResources.en },
      es: { app: es, ...rendererResources.es },
    } as unknown as Record<string, Record<string, object>>,
    interpolation: { escapeValue: false },
    showSupportNotice: false,
  });
}

export function setLanguage(lng: string) {
  try {
    localStorage.setItem('ws.lang', lng);
  } catch {
    /* private mode: the choice just isn't remembered */
  }
  document.documentElement.lang = lng;
  return i18next.changeLanguage(lng);
}
