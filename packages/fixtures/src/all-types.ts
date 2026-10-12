import type { QuestionnaireInput } from '@wansurvey/schema';

/** A questionnaire text: interviews are in Spanish; other languages are added as such. */
const es = (text: string) => ({ es: text });
const opts = (...labels: string[]) => labels.map((label, i) => ({ code: i + 1, label: es(label) }));

/** One of every MVP question type, with mode variants, to exercise the renderer. */
export const allTypes: QuestionnaireInput = {
  id: 'ALL_TYPES_DEMO',
  title: es('Todos los tipos de pregunta'),
  defaultLanguage: 'es',
  languages: ['es'],
  settings: {
    specialCodes: {
      DK: { code: -8, label: es('No sabe'), offeredIn: ['CATI', 'CAPI', 'PAPI'] },
      RF: { code: -9, label: es('Rehúsa'), offeredIn: ['CATI', 'CAPI', 'PAPI'] },
      NA: { code: -7, label: es('No aplica'), offeredIn: [] },
    },
    cawiShowSpecialCodes: false,
  },
  sections: [
    {
      id: 'S1',
      title: es('Opciones'),
      items: [
        {
          kind: 'static',
          id: 'INTRO',
          role: 'info',
          text: es('Este ejemplo muestra todos los tipos de pregunta.'),
        },
        {
          kind: 'question',
          id: 'Q_SINGLE',
          name: 'Q_SINGLE',
          type: 'single',
          text: es('¿Qué fruta prefiere?'),
          options: opts('Manzana', 'Plátano', 'Mango'),
          variants: {
            CATI: {
              interviewerInstruction: es('LEA LAS OPCIONES'),
              readOptions: true,
            },
            CAWI: { displayAs: 'buttons' },
          },
        },
        {
          kind: 'question',
          id: 'Q_DROPDOWN',
          name: 'Q_DROPDOWN',
          type: 'single',
          text: es('País de nacimiento'),
          options: opts('Perú', 'Chile', 'Bolivia', 'Otro'),
          variants: {
            CATI: { displayAs: 'dropdown' },
            CAPI: { displayAs: 'dropdown' },
            CAWI: { displayAs: 'dropdown' },
          },
        },
        {
          kind: 'question',
          id: 'Q_MULTI',
          name: 'Q_MULTI',
          type: 'multi',
          text: es('¿Cuáles de estos usa?'),
          options: [
            ...opts('Bus', 'Bicicleta', 'Auto'),
            { code: 4, label: es('Otro'), otherSpecify: true },
            { code: 99, label: es('Ninguno'), exclusive: true },
          ],
          maxSelections: 3,
        },
        {
          kind: 'question',
          id: 'Q_YESNO',
          name: 'Q_YESNO',
          type: 'yesno',
          text: es('¿Vive en una ciudad?'),
          skips: [{ when: 'Q_YESNO == 2', to: 'Q_NUMBER' }],
        },
        {
          kind: 'question',
          id: 'Q_CITY',
          name: 'Q_CITY',
          type: 'text',
          text: es('¿Qué ciudad?'),
          maxLength: 40,
        },
      ],
    },
    {
      id: 'S2',
      title: es('Números y fechas'),
      items: [
        {
          kind: 'question',
          id: 'Q_NUMBER',
          name: 'Q_NUMBER',
          type: 'numeric',
          text: es('¿Cuántas horas durmió?'),
          min: 0,
          max: 24,
          decimals: 1,
          unit: es('horas'),
          validations: [
            {
              id: 'little',
              severity: 'warning',
              when: 'Q_NUMBER < 3',
              message: es('Muy poco sueño; confirme'),
            },
          ],
        },
        {
          kind: 'question',
          id: 'Q_DATE',
          name: 'Q_DATE',
          type: 'date',
          text: es('Fecha de nacimiento'),
          maxDate: 'today()',
        },
        {
          kind: 'question',
          id: 'Q_TIME',
          name: 'Q_TIME',
          type: 'time',
          text: es('Hora habitual de despertar'),
        },
        {
          kind: 'question',
          id: 'Q_DATETIME',
          name: 'Q_DATETIME',
          type: 'datetime',
          text: es('¿Cuándo empezó el último corte de luz?'),
          required: false,
        },
        { kind: 'pagebreak', id: 'PB1' },
        {
          kind: 'question',
          id: 'Q_LONG',
          name: 'Q_LONG',
          type: 'text',
          text: es('¿Comentarios sobre su barrio?'),
          maxLength: 500,
          required: false,
        },
      ],
    },
    {
      id: 'S3',
      title: es('Escalas y grillas'),
      items: [
        {
          kind: 'question',
          id: 'Q_NPS',
          name: 'Q_NPS',
          type: 'scale',
          text: es('¿Qué tan probable es que nos recomiende?'),
          scale: {
            style: 'nps',
            min: 0,
            max: 10,
            minLabel: es('Nada probable'),
            maxLabel: es('Muy probable'),
          },
        },
        {
          kind: 'question',
          id: 'Q_LIKERT',
          name: 'Q_LIKERT',
          type: 'scale',
          text: es('El servicio fue rápido'),
          scale: {
            style: 'likert',
            min: 1,
            max: 5,
            minLabel: es('Muy en desacuerdo'),
            maxLabel: es('Muy de acuerdo'),
          },
        },
        {
          kind: 'question',
          id: 'Q_SLIDER',
          name: 'Q_SLIDER',
          type: 'scale',
          text: es('¿Qué tan satisfecho está en general?'),
          scale: { style: 'slider', min: 0, max: 100, step: 5 },
        },
        {
          kind: 'question',
          id: 'Q_GRID',
          name: 'Q_GRID',
          type: 'grid',
          text: es('Califique cada servicio'),
          options: opts('Malo', 'Regular', 'Bueno'),
          rows: [
            { code: 'water', label: es('Agua') },
            { code: 'power', label: es('Electricidad') },
            { code: 'roads', label: es('Caminos') },
          ],
        },
        {
          kind: 'question',
          id: 'Q_RANK',
          name: 'Q_RANK',
          type: 'ranking',
          text: es('Ordene estas prioridades (la más importante primero)'),
          options: opts('Salud', 'Educación', 'Empleo'),
        },
      ],
    },
    {
      id: 'S4',
      title: es('Personas'),
      items: [
        {
          kind: 'roster',
          id: 'KIDS',
          name: 'KIDS',
          title: es('Hijos'),
          count: { type: 'open', max: 5 },
          rowLabel: 'K_NAME',
          items: [
            {
              kind: 'question',
              id: 'K_NAME',
              name: 'K_NAME',
              type: 'text',
              text: es('Nombre del hijo {{index}}'),
            },
            {
              kind: 'question',
              id: 'K_AGE',
              name: 'K_AGE',
              type: 'numeric',
              min: 0,
              max: 30,
              text: es('¿Qué edad tiene {{K_NAME}}?'),
            },
          ],
        },
      ],
    },
  ],
};
