/**
 * The words of the About and Privacy pages, in the two interface languages. They describe what
 * the application does with data; who answers for it (the organisation that runs the
 * installation) and where to write come from the server's settings, so the same text is true in
 * every installation. The legal basis of each survey is the organisation's to declare (it is a
 * setting of every project); its legal area should read this text before it is published.
 */
export interface Facts {
  version: string;
  organisation: string | null;
  privacyContact: string | null;
  services: { geocoder: boolean; sms: boolean; microsoftSignIn: boolean };
}

export interface Section {
  id: string;
  title: string;
  paragraphs?: string[];
  items?: string[];
}

export interface Page {
  title: string;
  intro: string;
  sections: Section[];
}

export const UPDATED = '2026-11-07';

const who = (f: Facts, es: boolean) =>
  f.organisation ??
  (es
    ? 'la organización que administra esta instalación'
    : 'the organisation that runs this installation');

const contactLine = (f: Facts, es: boolean) =>
  f.privacyContact
    ? es
      ? `Escriba a ${f.privacyContact}.`
      : `Write to ${f.privacyContact}.`
    : es
      ? 'Escriba al administrador de su organización.'
      : 'Write to your organisation’s administrator.';

export function aboutPage(f: Facts, es: boolean): Page {
  return es
    ? {
        title: 'Acerca de WanSurvey',
        intro:
          'WanSurvey es una plataforma para hacer encuestas por teléfono, en persona, por internet y en papel, con el mismo cuestionario y los mismos resultados.',
        sections: [
          {
            id: 'what',
            title: 'Qué es',
            paragraphs: [
              'Un cuestionario se diseña una vez y se aplica por el canal que convenga: llamada (CATI), visita con tableta, incluso sin conexión (CAPI), enlace web o correo (CAWI), SMS o formulario en papel (PAPI). Las respuestas de todos los canales llegan al mismo lugar, con la misma lógica de saltos y validaciones.',
            ],
            items: [
              'Diseño de cuestionarios con lógica, traducciones y versiones, y aprobación antes de publicar.',
              'Muestras y listas de casos, asignación a entrevistadores, metas y seguimiento del trabajo de campo.',
              'Difusión por correo, SMS o enlaces, con respuestas pre-rellenadas desde la muestra o desde la dirección.',
              'Revisión de calidad de las entrevistas, exportación a Excel, SPSS, Stata y SQL, y un modelo para análisis en BI.',
              'Registro de personas que no desean ser contactadas, respetado por todos los canales.',
            ],
          },
          {
            id: 'who',
            title: 'Quién la administra',
            paragraphs: [
              f.organisation
                ? `Esta instalación la administra ${f.organisation}. Esa organización decide qué encuestas se hacen, a quién se contacta y durante cuánto tiempo se conservan los datos.`
                : 'La organización que administra esta instalación decide qué encuestas se hacen, a quién se contacta y durante cuánto tiempo se conservan los datos.',
              'Para saber cómo se tratan los datos personales, vea la Política de Privacidad.',
            ],
          },
          {
            id: 'version',
            title: 'Versión',
            paragraphs: [
              `Versión ${f.version}. La aplicación está en desarrollo activo: los cambios de cada versión están en el registro de cambios del proyecto.`,
            ],
          },
          {
            id: 'access',
            title: 'Accesibilidad',
            paragraphs: [
              'La aplicación se prueba con herramientas de accesibilidad y con teclado, y las encuestas web se pueden contestar sin ratón y con lector de pantalla. Si encuentra una barrera, avísenos para corregirla.',
            ],
          },
          {
            id: 'contact',
            title: 'Contacto',
            paragraphs: [contactLine(f, true)],
          },
        ],
      }
    : {
        title: 'About WanSurvey',
        intro:
          'WanSurvey is a platform for surveys by telephone, in person, on the web and on paper, with one questionnaire and one set of results.',
        sections: [
          {
            id: 'what',
            title: 'What it is',
            paragraphs: [
              'A questionnaire is designed once and fielded through whichever channel suits: phone calls (CATI), visits with a tablet, even offline (CAPI), web links or e-mail (CAWI), SMS, or paper forms (PAPI). The answers from every channel arrive in one place, with the same routing and checks.',
            ],
            items: [
              'Questionnaire design with logic, translations and versions, and approval before publishing.',
              'Samples and case lists, assignment to interviewers, goals and fieldwork follow-up.',
              'Outreach by e-mail, SMS or links, with answers pre-filled from the sample or from the address.',
              'Quality review of interviews, export to Excel, SPSS, Stata and SQL, and a model for BI analysis.',
              'A registry of people who do not want to be contacted, honoured by every channel.',
            ],
          },
          {
            id: 'who',
            title: 'Who runs it',
            paragraphs: [
              f.organisation
                ? `This installation is run by ${f.organisation}. That organisation decides which surveys are made, whom to contact and how long data is kept.`
                : 'The organisation that runs this installation decides which surveys are made, whom to contact and how long data is kept.',
              'To know how personal data is handled, see the Privacy Policy.',
            ],
          },
          {
            id: 'version',
            title: 'Version',
            paragraphs: [
              `Version ${f.version}. The application is under active development: the changes of each version are in the project’s changelog.`,
            ],
          },
          {
            id: 'access',
            title: 'Accessibility',
            paragraphs: [
              'The application is tested with accessibility tools and by keyboard, and web surveys can be answered without a mouse and with a screen reader. If you meet a barrier, tell us so it can be fixed.',
            ],
          },
          { id: 'contact', title: 'Contact', paragraphs: [contactLine(f, false)] },
        ],
      };
}

export function privacyPage(f: Facts, es: boolean): Page {
  const outside = (items: string[], on: boolean, text: string) => (on ? [...items, text] : items);
  if (es) {
    return {
      title: 'Política de Privacidad',
      intro: `Última actualización: ${UPDATED}. Explica qué datos trata WanSurvey, para qué, quién los recibe, cuánto tiempo se conservan y cómo ejercer sus derechos.`,
      sections: [
        {
          id: 'controller',
          title: '1. Quién es responsable de sus datos',
          paragraphs: [
            `El responsable del tratamiento es ${who(f, true)}, que usa WanSurvey para sus encuestas. WanSurvey es la herramienta: no usa los datos para sus propios fines ni los vende.`,
            contactLine(f, true),
          ],
        },
        {
          id: 'who',
          title: '2. A quién se refiere',
          items: [
            'Personas que participan en una encuesta (por teléfono, en persona, por internet o en papel).',
            'Personas que usan la aplicación por su trabajo: administradores, diseñadores, entrevistadores, supervisores y analistas.',
          ],
        },
        {
          id: 'respondents',
          title: '3. Qué datos tratamos de quienes participan',
          items: [
            'Sus respuestas al cuestionario.',
            'Los datos de contacto y de la muestra que la organización ya tenía (por ejemplo nombre, teléfono, correo, dirección, región), que se usan para localizarle, para personalizar la encuesta y para saber a quién corresponde cada respuesta.',
            'Datos del propio trabajo de campo: fecha y hora, duración, resultado de cada intento de llamada o visita, idioma, y un identificador del navegador o dispositivo para que pueda continuar donde lo dejó.',
            'En entrevistas con entrevistador, si el proyecto lo activa, la posición del dispositivo del entrevistador al empezar y al terminar la entrevista, que indica dónde se hizo. Las encuestas web no registran la posición.',
            'En encuestas por correo, si pulsó el enlace y, cuando el proyecto lo mide, si abrió el mensaje. En SMS, si respondió con una palabra de baja.',
            'Si el proyecto lo activa y usted lo acepta al inicio, la grabación de audio de la entrevista presencial.',
            'Señales de calidad calculadas a partir de la entrevista (velocidad, respuestas repetidas, coincidencias entre entrevistas) para que un revisor detecte entrevistas dudosas. No se usan para decidir nada sobre usted.',
            'Si el cuestionario lo pregunta, datos de categorías especiales (salud, origen, creencias, orientación sexual, afiliación sindical, datos biométricos o antecedentes judiciales). Se tratan con cuidado reforzado, se protegen como datos personales y solo se preguntan después del aviso informativo. Las encuestas pueden excluir a las personas menores de una edad mínima, y en ese caso la entrevista termina.',
          ],
        },
        {
          id: 'staff',
          title: '4. Qué datos tratamos de quienes usan la aplicación',
          items: outside(
            [
              'Nombre, correo y rol. La contraseña se guarda solo de forma irreversible (hash Argon2id) y el segundo factor, cifrado.',
              'Datos de sesión: dirección IP y navegador, para proteger la cuenta y registrar los accesos.',
              'Si el proyecto lo activa, la posición de su dispositivo al empezar y al terminar cada entrevista presencial y, si activa la grabación de audio, su voz durante la entrevista. El proyecto debe avisarle antes.',
              'Indicadores de calidad de su trabajo (tiempos, patrones de respuesta, coincidencias con otras entrevistas y una puntuación de riesgo) que un revisor usa para decidir qué entrevistas revisar. Ninguna decisión sobre usted se toma de forma automática por este indicador.',
              'Un registro de auditoría, que solo se puede ampliar, de las acciones importantes: quién hizo qué y cuándo (inicios de sesión, cambios de roles, publicaciones, exportaciones, consulta de datos personales).',
            ],
            f.services.microsoftSignIn,
            'Si entra con Microsoft, recibimos de Microsoft su nombre y correo para identificarle; no vemos su contraseña de Microsoft.',
          ),
        },
        {
          id: 'purposes',
          title: '5. Para qué y con qué base legal',
          paragraphs: [
            'Los datos se usan solo para hacer la encuesta, localizar a las personas de la muestra, controlar la calidad del trabajo, producir estadísticas y proteger la seguridad de la aplicación.',
            'La base legal (por ejemplo consentimiento, interés legítimo o misión de interés público) la declara la organización para cada encuesta; en llamadas, visitas, correo y SMS no se contacta a nadie hasta que se ha declarado. Si le contactaron sin su consentimiento y la base es otra, puede oponerse en cualquier momento (sección 9).',
          ],
        },
        {
          id: 'cookies',
          title: '6. Cookies y almacenamiento en su dispositivo',
          items: [
            'Una cookie de sesión, solo para el personal, necesaria para mantener la sesión abierta (no accesible desde scripts, expira por inactividad). Un código de protección contra solicitudes falsas acompaña a cada cambio.',
            'Preferencias en su navegador: idioma, tema claro u oscuro y, en la encuesta web, el identificador que permite continuar donde la dejó y guardar sus respuestas si se pierde la conexión.',
            'En las tabletas de entrevistadores, los casos descargados y las entrevistas pendientes se guardan en el dispositivo hasta enviarse y se borran al devolver la tableta.',
            'No usamos cookies publicitarias, de análisis ni de terceros, ni mostramos publicidad.',
          ],
        },
        {
          id: 'recipients',
          title: '7. Quién recibe los datos',
          items: outside(
            outside(
              [
                'Las personas de la organización que necesitan los datos para su trabajo, según su rol. Los datos personales aparecen ocultos salvo para quien tiene permiso expreso, y cada consulta queda registrada.',
                'Los proveedores que alojan la aplicación y envían correos, que tratan los datos por encargo y solo para ese fin.',
                'Si el personal activa las notificaciones del navegador, el servicio de notificaciones de su navegador (Google, Apple o Mozilla) las entrega; el texto es genérico y no contiene datos personales.',
              ],
              f.services.sms,
              'El proveedor de mensajes SMS, que recibe el número de teléfono y el texto del mensaje.',
            ),
            f.services.geocoder,
            'Un servicio de mapas (OpenStreetMap Nominatim) que recibe las direcciones de la muestra para ubicarlas, sin el nombre de la persona.',
          ),
          paragraphs: [
            'No vendemos datos ni los cedemos a terceros para sus propios fines. Si la ley obliga a comunicar datos a una autoridad, la organización responsable decide cómo atenderlo.',
          ],
        },
        {
          id: 'retention',
          title: '8. Cuánto tiempo se conservan',
          items: [
            'Cada proyecto nuevo empieza con un plazo de 365 días tras el cual, cada noche, los casos terminados pierden sus datos personales; la organización puede cambiarlo. En proyectos más antiguos o si lo deja vacío, los datos se conservan hasta que la organización los borre. Las respuestas que no son personales se conservan para las estadísticas.',
            'Las grabaciones de audio, si existen, se borran a los 90 días de la revisión de la entrevista salvo que el proyecto fije otro plazo.',
            'El registro de auditoría se conserva el tiempo que la organización determine, porque sirve para demostrar quién accedió a qué.',
            'Una solicitud de no ser contactado se guarda para respetarla durante el plazo que fije el proyecto; guardamos para ello solo el teléfono o el correo, no sus respuestas.',
          ],
        },
        {
          id: 'rights',
          title: '9. Sus derechos',
          paragraphs: [
            'Puede pedir a la organización responsable que le dé una copia de sus datos, los corrija, los borre, limite su uso, o dejar de contactarle. Si dio su consentimiento, puede retirarlo cuando quiera sin que afecte a lo anterior. La organización puede obtener todos los datos de una persona en un archivo y borrar sus datos personales desde la aplicación; ambas acciones quedan registradas.',
            'Cada correo de invitación incluye un enlace para no recibir más correos, y en una llamada puede pedir que no le vuelvan a llamar; ambas peticiones se respetan en todos los canales.',
            'Si cree que sus datos no se tratan bien, puede reclamar ante la autoridad de protección de datos de su país.',
            contactLine(f, true),
          ],
        },
        {
          id: 'security',
          title: '10. Cómo protegemos los datos',
          items: [
            'Conexión cifrada, contraseñas protegidas con Argon2id, segundo factor obligatorio para administradores, sesiones con límites de inactividad y bloqueo tras intentos fallidos.',
            'Los datos personales de la muestra se cifran en la base de datos, y los de cada organización están aislados de las demás a nivel de la propia base de datos.',
            'Permisos por rol comprobados en el servidor en cada operación; los datos personales se ocultan en pantalla y en las exportaciones para quien no tiene permiso.',
            'Registro de auditoría que la aplicación solo puede ampliar, pruebas automáticas de seguridad y revisión de dependencias en cada cambio.',
          ],
        },
        {
          id: 'transfers',
          title: '11. Dónde están los datos',
          paragraphs: [
            'Los datos se almacenan en la región del proveedor de alojamiento que eligió la organización. Si esa región está fuera de su país, la organización es responsable de contar con las garantías que su ley exige.',
          ],
        },
        {
          id: 'changes',
          title: '12. Cambios en esta política',
          paragraphs: [
            `Si el tratamiento cambia, esta página se actualiza y cambia la fecha de arriba (${UPDATED}). Los cambios importantes se comunican a través de la organización.`,
          ],
        },
      ],
    };
  }
  return {
    title: 'Privacy Policy',
    intro: `Last updated: ${UPDATED}. It explains what data WanSurvey handles, what for, who receives it, how long it is kept and how to use your rights.`,
    sections: [
      {
        id: 'controller',
        title: '1. Who answers for your data',
        paragraphs: [
          `The controller is ${who(f, false)}, which uses WanSurvey for its surveys. WanSurvey is the tool: it does not use the data for its own purposes and does not sell it.`,
          contactLine(f, false),
        ],
      },
      {
        id: 'who',
        title: '2. Whom this is about',
        items: [
          'People who take part in a survey (by phone, in person, on the web or on paper).',
          'People who use the application for their work: administrators, designers, interviewers, supervisors and analysts.',
        ],
      },
      {
        id: 'respondents',
        title: '3. What data we handle about people who take part',
        items: [
          'Your answers to the questionnaire.',
          'Contact and sample data the organisation already held (for example name, phone, e-mail, address, region), used to reach you, to personalise the survey and to know whom each answer belongs to.',
          'Fieldwork data: date and time, duration, the result of each call or visit attempt, language, and a browser or device identifier so you can continue where you left off.',
          'In interviews with an interviewer, if the project turns it on, the position of the interviewer’s device at the start and the end of the interview, which shows where it took place. Web surveys do not record position.',
          'In e-mail surveys, whether you clicked the link and, when the project measures it, whether you opened the message. In SMS, whether you replied with a stop word.',
          'If the project turns it on and you agree at the start, an audio recording of the face-to-face interview.',
          'Quality signals computed from the interview (speed, repeated answers, matches between interviews) so a reviewer can spot doubtful interviews. They are not used to decide anything about you.',
          'If the questionnaire asks for it, special-category data (health, origin, beliefs, sexual orientation, trade-union membership, biometric data or criminal records). It gets stricter care, is protected as personal data and is asked only after the information notice. Surveys can exclude people under a minimum age, and then the interview ends.',
        ],
      },
      {
        id: 'staff',
        title: '4. What data we handle about people who use the application',
        items: outside(
          [
            'Name, e-mail and role. The password is kept only in irreversible form (Argon2id hash) and the second factor encrypted.',
            'Session data: IP address and browser, to protect the account and record access.',
            'If the project turns it on, the position of your device at the start and the end of each face-to-face interview and, if it turns audio recording on, your voice during the interview. The project must tell you beforehand.',
            'Quality indicators about your work (timing, answer patterns, matches with other interviews and a risk score) that a reviewer uses to decide which interviews to check. No decision about you is taken automatically from this indicator.',
            'An audit log, which can only be added to, of the important actions: who did what and when (sign-ins, role changes, publications, exports, views of personal data).',
          ],
          f.services.microsoftSignIn,
          'If you sign in with Microsoft, we receive your name and e-mail from Microsoft to identify you; we never see your Microsoft password.',
        ),
      },
      {
        id: 'purposes',
        title: '5. What for, and the legal basis',
        paragraphs: [
          'Data is used only to run the survey, reach the people in the sample, check the quality of the work, produce statistics and keep the application secure.',
          'The legal basis (for example consent, legitimate interest or a public-interest task) is declared by the organisation for each survey; for calls, visits, e-mail and SMS nobody is contacted until it has been declared. If you were contacted without consent and the basis is another one, you can object at any time (section 9).',
        ],
      },
      {
        id: 'cookies',
        title: '6. Cookies and storage on your device',
        items: [
          'A session cookie, for staff only, needed to keep the session open (not readable by scripts, expires when idle). A protection code against forged requests goes with every change.',
          'Preferences in your browser: language, light or dark theme and, in the web survey, the identifier that lets you continue where you left off and keeps your answers if the connection drops.',
          'On interviewers’ tablets, the downloaded cases and the pending interviews are kept on the device until sent and are removed when the tablet is returned.',
          'We use no advertising, analytics or third-party cookies and show no advertising.',
        ],
      },
      {
        id: 'recipients',
        title: '7. Who receives the data',
        items: outside(
          outside(
            [
              'People in the organisation who need the data for their work, by role. Personal data is hidden except for those with explicit permission, and every view is logged.',
              'The providers that host the application and send e-mail, who handle the data on its behalf and only for that purpose.',
              'If staff turn on browser notifications, the notification service of their browser (Google, Apple or Mozilla) delivers them; the text is generic and holds no personal data.',
            ],
            f.services.sms,
            'The SMS provider, which receives the phone number and the text of the message.',
          ),
          f.services.geocoder,
          'A mapping service (OpenStreetMap Nominatim) that receives the sample’s addresses to place them, without the person’s name.',
        ),
        paragraphs: [
          'We do not sell data or hand it to third parties for their own purposes. If the law requires data to be given to an authority, the responsible organisation decides how to answer.',
        ],
      },
      {
        id: 'retention',
        title: '8. How long it is kept',
        items: [
          'Each new project starts with a period of 365 days after which, every night, finished cases lose their personal data; the organisation can change it. In older projects, or if it clears the period, the data is kept until the organisation deletes it. Answers that are not personal are kept for statistics.',
          'Audio recordings, if any, are deleted 90 days after the interview is reviewed unless the project sets another period.',
          'The audit log is kept as long as the organisation decides, because it shows who accessed what.',
          'A request not to be contacted is kept to be honoured for the period the project sets; only the phone number or e-mail is kept for it, not your answers.',
        ],
      },
      {
        id: 'rights',
        title: '9. Your rights',
        paragraphs: [
          'You can ask the responsible organisation to give you a copy of your data, correct it, erase it, limit its use, or stop contacting you. If you gave consent, you can withdraw it at any time without affecting what came before. The organisation can get everything held about a person in one file and erase their personal data from the application; both actions are logged.',
          'Every invitation e-mail has a link to stop receiving e-mails, and on a call you can ask not to be called again; both requests are honoured in every channel.',
          'If you think your data is not handled properly, you can complain to the data protection authority of your country.',
          contactLine(f, false),
        ],
      },
      {
        id: 'security',
        title: '10. How we protect the data',
        items: [
          'Encrypted connection, passwords protected with Argon2id, a second factor required for administrators, sessions that expire when idle and lock after failed attempts.',
          'The sample’s personal data is encrypted in the database, and each organisation’s data is isolated from the others by the database itself.',
          'Role permissions checked on the server for every operation; personal data is hidden on screen and in exports for those without permission.',
          'An audit log the application can only add to, automatic security tests and dependency checks on every change.',
        ],
      },
      {
        id: 'transfers',
        title: '11. Where the data is',
        paragraphs: [
          'Data is stored in the region of the hosting provider the organisation chose. If that region is outside your country, the organisation is responsible for having the safeguards its law requires.',
        ],
      },
      {
        id: 'changes',
        title: '12. Changes to this policy',
        paragraphs: [
          `If the handling changes, this page is updated and the date above changes (${UPDATED}). Important changes are communicated through the organisation.`,
        ],
      },
    ],
  };
}

/**
 * The terms of use and confidentiality undertaking every person accepts before working in the
 * application (the version is `TERMS_VERSION` of the schema package: raise it when this text
 * changes, and everyone is asked again). It binds the person to the organisation that runs the
 * installation; the organisation's legal area must agree the wording, the consequences and, in
 * labour relations, how it fits the contract.
 */
export function termsPage(f: Facts, es: boolean): Page {
  const org = f.organisation ?? (es ? 'su organización' : 'your organisation');
  return es
    ? {
        title: 'Términos de uso y compromiso de confidencialidad',
        intro: `Para trabajar en WanSurvey, ${org} le pide leer y aceptar lo siguiente. Su aceptación queda registrada con la fecha y la versión del texto.`,
        sections: [
          {
            id: 'who',
            title: '1. Quién puede usar la aplicación',
            paragraphs: [
              'Solo las personas autorizadas por la organización, con la cuenta y el rol que se les asignó. La cuenta es personal.',
            ],
          },
          {
            id: 'use',
            title: '2. Uso permitido',
            items: [
              'Use la aplicación solo para el trabajo para el que se le dio acceso: diseñar, realizar, revisar o analizar las encuestas de su proyecto.',
              'Acceda únicamente a los datos que necesita para ese trabajo. Que el sistema le deje ver algo no significa que pueda hacerlo.',
              'No comparta su contraseña, su segundo factor ni su sesión. Cierre la sesión en equipos que no son suyos.',
            ],
          },
          {
            id: 'confidentiality',
            title: '3. Confidencialidad',
            paragraphs: [
              'Los datos de las personas encuestadas (sus respuestas, sus datos de contacto y todo lo que permita identificarlas) son confidenciales. Usted se compromete a guardar secreto sobre ellos.',
            ],
            items: [
              'No los copie, descargue, fotografíe ni envíe fuera de los medios autorizados por la organización (por ejemplo a su correo o teléfono personal, a mensajería o a servicios en la nube que no sean los de la organización).',
              'No los revele a nadie que no esté autorizado, ni dentro ni fuera de la organización.',
              'No intente identificar a quien respondió una encuesta anónima ni cruzar datos para averiguarlo.',
              'No use los datos de contacto para nada distinto de la encuesta, ni los guarde para después.',
            ],
          },
          {
            id: 'prohibited',
            title: '4. Lo que no está permitido',
            items: [
              'Acceder a datos por curiosidad, de conocidos o de personas de su entorno.',
              'Inventar, alterar o copiar entrevistas, o responder por otra persona.',
              'Intentar saltarse los controles de acceso, probar contraseñas o usar cuentas ajenas.',
              'Llamar, escribir o visitar a una persona que pidió no ser contactada.',
            ],
          },
          {
            id: 'records',
            title: '5. Lo que se registra',
            paragraphs: [
              'La aplicación registra quién hace qué y cuándo (inicios de sesión, consulta de datos personales, exportaciones, cambios). En las entrevistas puede registrarse la posición del dispositivo y, si el proyecto lo activa y la persona lo acepta, el audio. Este registro sirve para proteger a las personas encuestadas, a la organización y a usted. Más detalle en la Política de Privacidad.',
            ],
          },
          {
            id: 'incidents',
            title: '6. Si algo sale mal',
            paragraphs: [
              'Si pierde un dispositivo con datos, sospecha que alguien usó su cuenta, envió datos a quien no debía o ve datos que no debería ver, avise de inmediato al administrador de su organización. Avisar pronto reduce el daño y protege a todos.',
            ],
          },
          {
            id: 'consequences',
            title: '7. Consecuencias',
            paragraphs: [
              'El incumplimiento puede llevar a retirar el acceso y a las medidas laborales, civiles o penales que correspondan según la ley y su contrato. La divulgación indebida de datos personales puede ser un delito.',
            ],
          },
          {
            id: 'duration',
            title: '8. Cuánto dura',
            paragraphs: [
              'Estas obligaciones siguen en vigor cuando termine su trabajo en la organización: el secreto sobre los datos no tiene fecha de fin.',
            ],
          },
          {
            id: 'version',
            title: '9. Cambios',
            paragraphs: [
              'Si este texto cambia, se le pedirá aceptarlo de nuevo antes de seguir trabajando.',
            ],
          },
        ],
      }
    : {
        title: 'Terms of use and confidentiality undertaking',
        intro: `To work in WanSurvey, ${org} asks you to read and accept the following. Your acceptance is recorded with its date and the version of the text.`,
        sections: [
          {
            id: 'who',
            title: '1. Who may use the application',
            paragraphs: [
              'Only people authorised by the organisation, with the account and role given to them. The account is personal.',
            ],
          },
          {
            id: 'use',
            title: '2. Permitted use',
            items: [
              'Use the application only for the work you were given access for: designing, carrying out, reviewing or analysing the surveys of your project.',
              'Access only the data you need for that work. That the system lets you see something does not mean you may.',
              'Do not share your password, your second factor or your session. Sign out on devices that are not yours.',
            ],
          },
          {
            id: 'confidentiality',
            title: '3. Confidentiality',
            paragraphs: [
              'The data of the people surveyed (their answers, their contact details and anything that could identify them) is confidential. You undertake to keep it secret.',
            ],
            items: [
              'Do not copy, download, photograph or send it outside the means authorised by the organisation (for example to your personal e-mail or phone, to messaging apps or to cloud services that are not the organisation’s).',
              'Do not disclose it to anyone who is not authorised, inside or outside the organisation.',
              'Do not try to identify who answered an anonymous survey or to cross data to find out.',
              'Do not use contact details for anything other than the survey, nor keep them for later.',
            ],
          },
          {
            id: 'prohibited',
            title: '4. What is not allowed',
            items: [
              'Looking at data out of curiosity, about acquaintances or people around you.',
              'Making up, altering or copying interviews, or answering for someone else.',
              'Trying to get round access controls, guessing passwords or using someone else’s account.',
              'Calling, writing to or visiting a person who asked not to be contacted.',
            ],
          },
          {
            id: 'records',
            title: '5. What is recorded',
            paragraphs: [
              'The application records who does what and when (sign-ins, views of personal data, exports, changes). In interviews the position of the device may be recorded and, if the project turns it on and the person agrees, the audio. This record protects the people surveyed, the organisation and you. More detail in the Privacy Policy.',
            ],
          },
          {
            id: 'incidents',
            title: '6. If something goes wrong',
            paragraphs: [
              'If you lose a device with data, suspect someone used your account, sent data to someone it should not go to or see data you should not see, tell your organisation’s administrator at once. Telling early reduces the harm and protects everyone.',
            ],
          },
          {
            id: 'consequences',
            title: '7. Consequences',
            paragraphs: [
              'A breach can lead to losing access and to the labour, civil or criminal measures the law and your contract provide for. Improper disclosure of personal data can be a crime.',
            ],
          },
          {
            id: 'duration',
            title: '8. How long it lasts',
            paragraphs: [
              'These obligations stay in force when your work for the organisation ends: secrecy about the data has no end date.',
            ],
          },
          {
            id: 'version',
            title: '9. Changes',
            paragraphs: [
              'If this text changes, you will be asked to accept it again before going on working.',
            ],
          },
        ],
      };
}
