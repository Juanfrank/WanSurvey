import { readFileSync } from 'node:fs';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { PASSWORD, PM, shot } from './helpers.js';

const INTERVIEWER = 'interviewer@demo.wansurvey.test';
const CODE = `EV${Date.now() % 100000}`;

// The whole journey as its users see it, in the Spanish interface they use.
test.use({ storageState: { cookies: [], origins: [] } });

async function signIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(PASSWORD);
  await page.getByRole('button', { name: 'Ingresar', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Bienvenido/ })).toBeVisible();
}

async function newBrowser(browser: Browser, phone = false) {
  const ctx = await browser.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 800 } },
  );
  return { ctx, page: await ctx.newPage() };
}

/** A frame of 30 neighbours: id, name, phone, e-mail, branch (1–3) and age. */
function frame() {
  const names = [
    'Ana',
    'Luis',
    'Rosa',
    'Jorge',
    'Elena',
    'Pedro',
    'Carmen',
    'Raúl',
    'Sofía',
    'Diego',
  ];
  const rows = ['id,first_name,phone,email,sede,edad'];
  for (let i = 1; i <= 30; i++)
    rows.push(
      [
        `V${String(i).padStart(3, '0')}`,
        names[i % 10],
        `96${String(1000000 + i * 4271).slice(0, 7)}`,
        `vecino${i}@example.org`,
        (i % 3) + 1,
        20 + ((i * 7) % 60),
      ].join(','),
    );
  return Buffer.from(rows.join('\n'));
}

test('a project from scratch: questionnaire, sample, calls, a web link, results and the data', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);

  // 1. The manager creates the project.
  await signIn(page, PM);
  await page.getByRole('link', { name: 'Proyectos' }).first().click();
  await page.getByRole('button', { name: 'Nuevo proyecto' }).click();
  await page.getByLabel('Nombre').fill(`Encuesta de satisfacción vecinal ${CODE}`);
  await page.getByLabel('Código').fill(CODE);
  await shot(page, 'journey-new-project');
  await page.getByRole('button', { name: 'Crear proyecto' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    `Encuesta de satisfacción vecinal ${CODE}`,
  );

  // 2. The questionnaire, built with the mouse.
  await page.getByLabel('Nombre del cuestionario').fill('Satisfacción con servicios');
  await page.getByRole('button', { name: 'Crear y abrir' }).click();
  // Its id comes from the name, as the exports will show it (Configuración → General).
  const sections = page.getByRole('tablist', { name: 'Secciones del cuestionario' });
  await sections.getByRole('tab', { name: 'Configuración', exact: true }).click();
  await expect(page.getByLabel('Id del cuestionario')).toHaveValue('SATISFACCION_CON_SERVICIOS');
  await sections.getByRole('tab', { name: 'Diseño', exact: true }).click();
  const outline = page.getByRole('tree', { name: 'Esquema' });
  await outline.getByRole('treeitem', { name: /SEC_A/ }).click();
  const varName = page.getByLabel('Nombre de variable');
  const addQuestion = async (type: RegExp, name: string, text: string) => {
    await page.getByRole('button', { name: 'Agregar una pregunta' }).click();
    await page.getByRole('menuitem', { name: type }).click();
    await page.getByRole('tab', { name: 'Pregunta', exact: true }).click();
    await varName.fill(name);
    await varName.press('Tab');
    await page.getByLabel('Texto de la pregunta (es)').fill(text);
  };
  // The branch: a link parameter answers it (?sede=2).
  await addQuestion(/^Opción única/, '_SEDE', '¿A cuál sede acudió, {{case.first_name}}?');
  await page.getByLabel('Etiqueta de la opción 1 (es)').fill('Norte');
  await page.getByLabel('Etiqueta de la opción 2 (es)').fill('Sur');
  await page.getByLabel('Etiqueta de la opción 2 (es)').press('Enter');
  await page.getByLabel('Etiqueta de la opción 3 (es)').fill('Centro');
  await page.getByRole('tab', { name: 'Lógica', exact: true }).click();
  await page.getByRole('textbox', { name: /^Parámetro del enlace/ }).fill('sede');
  await addQuestion(
    /^Escala/,
    '_SATIS',
    'En general, ¿qué tan satisfecho/a está con la atención en la sede {{A_SEDE | label}}?',
  );
  await page.getByLabel('Colores').selectOption({ label: 'Rojo → ámbar → verde' });
  await page.getByLabel('Etiqueta del extremo inferior (es)').fill('Nada satisfecho/a');
  await page.getByLabel('Etiqueta del extremo superior (es)').fill('Muy satisfecho/a');
  // What to improve: only for 3 or less, optional.
  await addQuestion(/^Texto/, '_MEJORA', '¿Qué deberíamos mejorar?');
  await page.getByLabel('Respuesta obligatoria').uncheck();
  await page.getByRole('tab', { name: 'Lógica', exact: true }).click();
  await page.getByRole('button', { name: 'Agregar condición' }).click();
  const variable = page.getByLabel('Condición 1: variable', { exact: true });
  await variable.fill('A_SATIS');
  await variable.press('Enter');
  await page.getByLabel('Condición 1: comparación').selectOption({ label: 'es como máximo' });
  await page.getByLabel('Condición 1: valor', { exact: true }).fill('3');
  await page.getByLabel('Condición 1: valor', { exact: true }).press('Tab');
  await expect(page.getByText(/Se lee:.*A_SATIS/)).toBeVisible();
  await addQuestion(/^Número/, '_EDAD', '¿Cuántos años tiene?');
  await page.getByRole('button', { name: 'Publicar…' }).click();
  await page.getByRole('button', { name: 'Publicar la versión 1' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  // The breadcrumb names the project; its list shows the version in use.
  await page
    .getByRole('navigation', { name: 'Ruta de navegación' })
    .getByRole('link', { name: `Encuesta de satisfacción vecinal ${CODE}` })
    .click();
  const row = page.getByRole('row', { name: /Satisfacción con servicios/ });
  await expect(row).toContainText('v1');
  await expect(row).toContainText('En uso');

  // 3. The sample: a frame of 30, a simple random sample for 6 interviews at 75 % response.
  await page.getByRole('tab', { name: 'Casos', exact: true }).click();
  await page.getByRole('tab', { name: 'Selector muestral' }).click();
  const selector = page.getByTestId('sampling');
  await selector.getByRole('button', { name: 'Importar muestra' }).click();
  await page.getByLabel('Archivo de muestra (.csv o .xlsx)').setInputFiles({
    name: 'vecinos.csv',
    mimeType: 'text/csv',
    buffer: frame(),
  });
  await page.getByRole('button', { name: 'Subir y leer' }).click();
  await page.getByLabel('Código de país para teléfonos sin él').fill('51');
  await page.getByRole('button', { name: 'Revisar el archivo' }).click();
  await page.getByRole('button', { name: 'Cargar 30 unidades al marco' }).click();
  await page.getByRole('button', { name: 'Seguir con el diseño' }).click();
  await expect(selector.getByTestId('frame-units')).toHaveText('30 unidades');
  await selector
    .getByRole('combobox', { name: 'Objetivo' })
    .selectOption({ label: 'Un número fijo de entrevistas' });
  await selector.getByRole('textbox', { name: 'Entrevistas deseadas' }).fill('6');
  await selector.getByRole('textbox', { name: 'Respuesta esperada' }).fill('75');
  await selector.getByRole('textbox', { name: 'Respuesta esperada' }).press('Tab');
  await expect(selector.locator('[data-size="toSelect"]')).toHaveText('8');
  page.once('dialog', (d) => void d.accept());
  await selector.getByRole('button', { name: 'Seleccionar la muestra y crear los casos…' }).click();
  await expect(selector.locator('[data-role="main"]')).toContainText('8');

  // 4. All eight to the interviewer; one attempt per case, so a no-answer closes it.
  await page.getByRole('tab', { name: 'Lista de casos' }).click();
  await expect(page.getByTestId('cases-table').locator('tbody tr')).toHaveCount(8);
  await page.getByLabel('Seleccionar todos los casos de esta página').check();
  await page.getByLabel('Asignar seleccionados a').selectOption({ label: 'Demo interviewer' });
  await page.getByRole('button', { name: 'Asignar', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Demo interviewer' })).toHaveCount(8);
  await page.getByRole('tab', { name: 'Configuración', exact: true }).click();
  await page.getByRole('tab', { name: 'Teléfono', exact: true }).click();
  // Calls all day, so the test does not depend on the hour it runs at.
  await page.getByLabel('Llamar desde').fill('00:00');
  await page.getByLabel('Llamar hasta').fill('00:00');
  await page.getByLabel('Intentos por caso').fill('1');
  await page.getByRole('button', { name: 'Guardar configuración' }).click();
  await expect(page.getByText('Configuración guardada.')).toBeVisible();

  // 5. The interviewer, in their own browser, lands on their cases and calls.
  const { ctx: ivCtx, page: iv } = await newBrowser(browser);
  await signIn(iv, INTERVIEWER);
  await iv
    .getByRole('main')
    .getByRole('link', { name: `Encuesta de satisfacción vecinal ${CODE}` })
    .click();
  // A caller lands on the call screen, with their callbacks beside it.
  await expect(iv.getByRole('tab', { name: 'Llamadas' })).toHaveAttribute('aria-selected', 'true');
  await expect(iv.getByRole('complementary', { name: 'Mis rellamadas' })).toBeVisible();
  const nextCase = iv.getByRole('button', { name: 'Siguiente caso N' });
  const call = async (outcome: string) => {
    await nextCase.click();
    await iv.getByRole('radio', { name: outcome }).check();
  };
  // No answer: the only attempt, so the case is exhausted.
  await call('2 No contesta');
  const exhausted = (await iv.getByRole('heading', { level: 3, name: /^Caso V/ }).textContent())!
    .replace('Caso ', '')
    .trim();
  await iv.getByRole('button', { name: /^Guardar resultado/ }).click();
  await expect(nextCase).toBeVisible();

  const interview = iv.getByRole('region', { name: /^Entrevista/ });
  const next = iv.getByRole('button', { name: /^Siguiente/ });
  // Not satisfied: the follow-up question appears.
  await call('1 Contestó — iniciar entrevista');
  await iv.getByRole('button', { name: /^Iniciar entrevista/ }).click();
  await iv.getByRole('radio', { name: '2 Sur' }).check();
  await next.click();
  await expect(interview).toContainText('en la sede Sur?');
  await interview.getByText('2', { exact: true }).click();
  await next.click();
  await iv.getByRole('textbox').first().fill('Más rapidez en la atención y mejor trato.');
  await next.click();
  await iv.getByRole('spinbutton').or(iv.getByRole('textbox')).first().fill('37');
  await next.click();
  await shot(iv, 'journey-interview-end');
  await iv.getByRole('button', { name: 'Enviar entrevista' }).click();
  await expect(iv.getByText(/Entrevista enviada/)).toBeVisible();
  // Satisfied: straight to the age.
  await call('1 Contestó — iniciar entrevista');
  await iv.getByRole('button', { name: /^Iniciar entrevista/ }).click();
  await iv.getByRole('radio', { name: '1 Norte' }).check();
  await next.click();
  await interview.getByText('5', { exact: true }).click();
  await next.click();
  await expect(iv.getByText('¿Cuántos años tiene?')).toBeVisible();
  await iv.getByRole('spinbutton').or(iv.getByRole('textbox')).first().fill('64');
  await next.click();
  await iv.getByRole('button', { name: 'Enviar entrevista' }).click();
  await expect(iv.getByText(/Entrevista enviada/)).toBeVisible();
  // A refusal, and an appointment for tomorrow.
  await call('7 Rechazo');
  await iv.getByRole('button', { name: /^Guardar resultado/ }).click();
  await expect(nextCase).toBeVisible();
  await call('9 Cita');
  await iv.getByRole('button', { name: 'Mañana 10:00' }).click();
  await iv.getByLabel('Nota (opcional)').fill('Prefiere que la llamen temprano.');
  await iv.getByRole('button', { name: /^Guardar resultado/ }).click();
  await expect(nextCase).toBeVisible();
  await shot(iv, 'journey-calls');
  await ivCtx.close();

  // 6. The manager sees the exhausted case: closed, no contact, its one attempt.
  await page.getByRole('tab', { name: 'Casos', exact: true }).click();
  await page.getByLabel('Buscar id o datos de muestra').fill(exhausted);
  await page.getByRole('button', { name: `Abrir el caso ${exhausted}`, exact: true }).click();
  const drawer = page.getByRole('dialog', { name: `Caso ${exhausted}` });
  await expect(drawer.getByTestId('case-disposition')).toHaveText('· Sin contacto');
  await expect(drawer).toContainText('1 intento');
  await expect(drawer.getByTestId('call-history')).toContainText('No contesta');
  await expect(drawer).toContainText('Seleccionado en la muestra');
  await shot(page, 'journey-exhausted-case');
  await page.keyboard.press('Escape');

  // 7. A personal web link with ?sede=3: started on a phone, finished on a computer
  // with the bare link. The branch is kept on the server and never asked.
  await page.getByRole('tab', { name: 'Cuestionarios', exact: true }).click();
  await page.getByRole('button', { name: 'Acciones de Satisfacción con servicios' }).click();
  await page.getByRole('menuitem', { name: /^Encuesta web/ }).click();
  await page.getByLabel('Nombre', { exact: true }).fill('Enlaces sede Centro');
  await page.getByRole('radio', { name: /Solo enlaces personales/ }).check();
  await page.getByRole('button', { name: 'Crear campaña' }).click();
  await page.getByRole('button', { name: 'Generar los enlaces de Enlaces sede Centro' }).click();
  const links = page.getByTestId('wave-links');
  await links.getByLabel('Agregar a todos los enlaces (opcional)').fill('sede=3');
  const linkText = await links.locator('[data-link]').first().textContent();
  const url = linkText!.match(/http\S+?\?sede=3/)![0];
  const phone = await newBrowser(browser, true);
  await phone.page.goto(url);
  await expect(phone.page.getByText(/en la sede Centro\?/)).toBeVisible();
  await expect(phone.page.getByText('Mayús+Intro')).toBeHidden();
  await shot(phone.page, 'journey-web-phone', { fullPage: false });
  await phone.page.getByRole('main').getByText('4', { exact: true }).click();
  await phone.page.getByRole('button', { name: /^Siguiente/ }).click();
  await expect(phone.page.getByText('¿Cuántos años tiene?')).toBeVisible();
  await expect(phone.page.getByText('Respuestas guardadas')).toBeVisible();
  await phone.ctx.close();
  const desk = await newBrowser(browser);
  await desk.page.goto(url.replace('?sede=3', ''));
  await expect(desk.page.getByText('¿Cuántos años tiene?')).toBeVisible();
  await desk.page.getByRole('spinbutton').or(desk.page.getByRole('textbox')).first().fill('45');
  await desk.page.getByRole('button', { name: /^Siguiente/ }).click();
  await desk.page.getByRole('button', { name: 'Enviar mis respuestas' }).click();
  await expect(desk.page.getByText('¡Muchas gracias por responder la encuesta!')).toBeVisible();
  await desk.ctx.close();
  // Back from the questionnaire's Distribution tab to the project.
  await page.goBack();

  // 8. Results: three completes, the scale as a distribution, the open answers, no raw pipes.
  await page.getByRole('tab', { name: 'Resultados', exact: true }).click();
  await expect(page.getByText('3 entrevistas completas')).toBeVisible();
  const topline = page.getByTestId('topline');
  await expect(topline.locator('[data-variable="A_SEDE"]')).toContainText(
    '¿A cuál sede acudió, …?',
  );
  await expect(page.getByRole('row', { name: /^Centro 33/ })).toBeVisible();
  await expect(topline.locator('[data-variable="A_SATIS"]')).toContainText('Media: 3,7');
  await expect(page.getByTestId('latest-A_MEJORA')).toContainText('Más rapidez en la atención');
  await expect(topline).not.toContainText('«');
  await shot(page, 'journey-results');

  // 9. The data for SPSS, with the case code beside the internal id.
  await page.getByRole('tab', { name: 'Exportar', exact: true }).click();
  await page.getByLabel('Formato').selectOption({ label: 'SPSS (.sav)' });
  await page.getByRole('button', { name: 'Exportar', exact: true }).click();
  const download = page.waitForEvent('download');
  await page
    .getByRole('link', { name: /^Descargar/ })
    .first()
    .click({ timeout: 30_000 });
  const file = await (await download).path();
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 4).toString()).toBe('$FL2');
  expect(bytes.includes(Buffer.from('case_code'))).toBe(true);
});
