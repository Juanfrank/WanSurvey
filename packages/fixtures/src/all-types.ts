import type { QuestionnaireInput } from '@wansurvey/schema';

const t = (en: string, es: string) => ({ en, es });
const opts = (...labels: [string, string][]) =>
  labels.map(([en, es], i) => ({ code: i + 1, label: t(en, es) }));

/** One of every MVP question type, with mode variants, to exercise the renderer. */
export const allTypes: QuestionnaireInput = {
  id: 'ALL_TYPES_DEMO',
  title: t('Every question type', 'Todos los tipos de pregunta'),
  defaultLanguage: 'en',
  languages: ['en', 'es'],
  settings: {
    specialCodes: {
      DK: { code: -8, label: t("Don't know", 'No sabe'), offeredIn: ['CATI', 'CAPI', 'PAPI'] },
      RF: { code: -9, label: t('Refused', 'Rehúsa'), offeredIn: ['CATI', 'CAPI', 'PAPI'] },
      NA: { code: -7, label: t('Not applicable', 'No aplica'), offeredIn: [] },
    },
    cawiShowSpecialCodes: false,
  },
  sections: [
    {
      id: 'S1',
      title: t('Choices', 'Opciones'),
      items: [
        {
          kind: 'static',
          id: 'INTRO',
          role: 'info',
          text: t(
            'This sample shows every question type.',
            'Este ejemplo muestra todos los tipos de pregunta.',
          ),
        },
        {
          kind: 'question',
          id: 'Q_SINGLE',
          name: 'Q_SINGLE',
          type: 'single',
          text: t('Which fruit do you prefer?', '¿Qué fruta prefiere?'),
          options: opts(['Apple', 'Manzana'], ['Banana', 'Plátano'], ['Mango', 'Mango']),
          variants: {
            CATI: {
              interviewerInstruction: t('READ OPTIONS', 'LEA LAS OPCIONES'),
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
          text: t('Country of birth', 'País de nacimiento'),
          options: opts(
            ['Peru', 'Perú'],
            ['Chile', 'Chile'],
            ['Bolivia', 'Bolivia'],
            ['Other', 'Otro'],
          ),
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
          text: t('Which of these do you use?', '¿Cuáles de estos usa?'),
          options: [
            ...opts(['Bus', 'Bus'], ['Bicycle', 'Bicicleta'], ['Car', 'Auto']),
            { code: 4, label: t('Other', 'Otro'), otherSpecify: true },
            { code: 99, label: t('None of these', 'Ninguno'), exclusive: true },
          ],
          maxSelections: 3,
        },
        {
          kind: 'question',
          id: 'Q_YESNO',
          name: 'Q_YESNO',
          type: 'yesno',
          text: t('Do you live in a city?', '¿Vive en una ciudad?'),
          skips: [{ when: 'Q_YESNO == 2', to: 'Q_NUMBER' }],
        },
        {
          kind: 'question',
          id: 'Q_CITY',
          name: 'Q_CITY',
          type: 'text',
          text: t('Which city?', '¿Qué ciudad?'),
          maxLength: 40,
        },
      ],
    },
    {
      id: 'S2',
      title: t('Numbers and dates', 'Números y fechas'),
      items: [
        {
          kind: 'question',
          id: 'Q_NUMBER',
          name: 'Q_NUMBER',
          type: 'numeric',
          text: t('How many hours did you sleep?', '¿Cuántas horas durmió?'),
          min: 0,
          max: 24,
          decimals: 1,
          unit: t('hours', 'horas'),
          validations: [
            {
              id: 'little',
              severity: 'warning',
              when: 'Q_NUMBER < 3',
              message: t('Very little sleep; please confirm', 'Muy poco sueño; confirme'),
            },
          ],
        },
        {
          kind: 'question',
          id: 'Q_DATE',
          name: 'Q_DATE',
          type: 'date',
          text: t('Date of birth', 'Fecha de nacimiento'),
          maxDate: 'today()',
        },
        {
          kind: 'question',
          id: 'Q_TIME',
          name: 'Q_TIME',
          type: 'time',
          text: t('Usual wake-up time', 'Hora habitual de despertar'),
        },
        {
          kind: 'question',
          id: 'Q_DATETIME',
          name: 'Q_DATETIME',
          type: 'datetime',
          text: t('When did the last power cut start?', '¿Cuándo empezó el último corte de luz?'),
          required: false,
        },
        { kind: 'pagebreak', id: 'PB1' },
        {
          kind: 'question',
          id: 'Q_LONG',
          name: 'Q_LONG',
          type: 'text',
          text: t('Any comments about your neighbourhood?', '¿Comentarios sobre su barrio?'),
          maxLength: 500,
          required: false,
        },
      ],
    },
    {
      id: 'S3',
      title: t('Scales and grids', 'Escalas y grillas'),
      items: [
        {
          kind: 'question',
          id: 'Q_NPS',
          name: 'Q_NPS',
          type: 'scale',
          text: t(
            'How likely are you to recommend us?',
            '¿Qué tan probable es que nos recomiende?',
          ),
          scale: {
            style: 'nps',
            min: 0,
            max: 10,
            minLabel: t('Not at all likely', 'Nada probable'),
            maxLabel: t('Extremely likely', 'Muy probable'),
          },
        },
        {
          kind: 'question',
          id: 'Q_LIKERT',
          name: 'Q_LIKERT',
          type: 'scale',
          text: t('The service was fast', 'El servicio fue rápido'),
          scale: {
            style: 'likert',
            min: 1,
            max: 5,
            minLabel: t('Strongly disagree', 'Muy en desacuerdo'),
            maxLabel: t('Strongly agree', 'Muy de acuerdo'),
          },
        },
        {
          kind: 'question',
          id: 'Q_SLIDER',
          name: 'Q_SLIDER',
          type: 'scale',
          text: t('How satisfied are you overall?', '¿Qué tan satisfecho está en general?'),
          scale: { style: 'slider', min: 0, max: 100, step: 5 },
        },
        {
          kind: 'question',
          id: 'Q_GRID',
          name: 'Q_GRID',
          type: 'grid',
          text: t('Rate each service', 'Califique cada servicio'),
          options: opts(['Poor', 'Malo'], ['Fair', 'Regular'], ['Good', 'Bueno']),
          rows: [
            { code: 'water', label: t('Water', 'Agua') },
            { code: 'power', label: t('Electricity', 'Electricidad') },
            { code: 'roads', label: t('Roads', 'Caminos') },
          ],
        },
        {
          kind: 'question',
          id: 'Q_RANK',
          name: 'Q_RANK',
          type: 'ranking',
          text: t(
            'Rank these priorities (most important first)',
            'Ordene estas prioridades (la más importante primero)',
          ),
          options: opts(['Health', 'Salud'], ['Education', 'Educación'], ['Jobs', 'Empleo']),
        },
      ],
    },
    {
      id: 'S4',
      title: t('People', 'Personas'),
      items: [
        {
          kind: 'roster',
          id: 'KIDS',
          name: 'KIDS',
          title: t('Children', 'Hijos'),
          count: { type: 'open', max: 5 },
          rowLabel: 'K_NAME',
          items: [
            {
              kind: 'question',
              id: 'K_NAME',
              name: 'K_NAME',
              type: 'text',
              text: t('Name of child {{index}}', 'Nombre del hijo {{index}}'),
            },
            {
              kind: 'question',
              id: 'K_AGE',
              name: 'K_AGE',
              type: 'numeric',
              min: 0,
              max: 30,
              text: t('How old is {{K_NAME}}?', '¿Qué edad tiene {{K_NAME}}?'),
            },
          ],
        },
      ],
    },
  ],
};
