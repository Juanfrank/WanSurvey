# Revisión de riesgos legales y de cumplimiento

Fecha: 2026-11-07 · Versión revisada: 0.1.0-alpha.19 (rama de trabajo)

**Qué es y qué no es.** Es una revisión técnica del código y de la documentación, hecha para que
el dueño, el gestor o el contratante de la aplicación sepan **dónde puede nacer una
responsabilidad** (civil, penal o administrativa) y qué hacer. **No es asesoría jurídica.** Las
leyes que aplican dependen del país de la organización y de las personas encuestadas (por
ejemplo el RGPD en Europa, o las leyes nacionales de protección de datos personales de cada país
de América Latina) y de la naturaleza de la encuesta (investigación, estadística oficial,
mercadeo, encargo de un cliente). El área jurídica de la institución debe leer esto, completarlo
y decidir. Donde digo «regímenes habituales» me refiero a lo que casi todas esas leyes comparten.

**Cómo leerlo.** Cada hallazgo dice qué vi (con el archivo), por qué importa, qué hacer y quién
lo hace: _Desarrollo_ (cambios en la aplicación) u _Organización_ (decisiones, contratos y
procedimientos que ninguna aplicación puede resolver). Los hallazgos marcados **Corregido** ya
se arreglaron en esta revisión.

## Resumen por prioridad

| #   | Hallazgo                                                                       | Prioridad | Quién                                         |
| --- | ------------------------------------------------------------------------------ | --------- | --------------------------------------------- |
| 1   | Conservación sin límite por defecto                                            | Alta      | **Mitigado** (proyectos nuevos) + Org.        |
| 2   | Sin aviso informativo al recoger datos                                         | Alta      | **Implementado** + Org. (el texto)            |
| 3   | Contacto telefónico sin base legal declarada ni listas nacionales de exclusión | Alta      | **Implementado** (base legal) + Org. (listas) |
| 4   | Geocodificación con un servicio público gratuito (OpenStreetMap)               | Alta      | Org. (+ Desarrollo)                           |
| 5   | Datos sensibles y menores sin controles específicos                            | Alta      | Desarrollo + Org.                             |
| 6   | Sin procedimiento de respuesta a incidentes de seguridad                       | Alta      | Organización                                  |
| 7   | Vigilancia de entrevistadores (posición, calidad, riesgo, voz)                 | Media     | Org. (+ Desarrollo)                           |
| 8   | Seguimiento de aperturas de correo sin opción de apagarlo                      | Media     | Desarrollo                                    |
| 9   | Registro de auditoría sin plazo de conservación; copias de seguridad           | Media     | Desarrollo + Org.                             |
| 10  | Sin términos de uso ni compromiso de confidencialidad del personal             | Media     | Desarrollo + Org.                             |
| 11  | Enlaces para compartir resultados que pueden no caducar                        | Media     | Desarrollo                                    |
| 12  | Seguridad: lo que falta para decir «razonablemente protegido»                  | Media     | Org. + Desarrollo                             |
| 13  | Texto de la Política de Privacidad inexacto en dos puntos                      | —         | **Corregido**                                 |
| 14  | Licencias, propiedad intelectual y atribuciones                                | Baja      | Organización                                  |
| 15  | Obligaciones administrativas fuera del código                                  | Alta      | Organización                                  |

## 1. Conservación sin límite por defecto

- **Qué vi.** `RetentionSettings.anonymiseAfterDays` es `null` por defecto
  (`packages/schema/src/project.ts`): si nadie lo configura, los datos personales de los casos
  terminados **no se borran nunca**. El borrado nocturno existe y funciona
  (`privacy.service.ts`), pero solo actúa si el proyecto fija un plazo.
- **Por qué importa.** Los regímenes habituales exigen conservar los datos solo el tiempo
  necesario para la finalidad (limitación del plazo). Conservar sin plazo es una infracción
  administrativa frecuente y agrava cualquier fuga.
- **Qué hacer.** _Desarrollo:_ pedir el plazo al crear el proyecto (obligatorio, con una
  sugerencia) y avisar en la pantalla de ajustes cuando está vacío. _Organización:_ fijar una
  política de conservación por tipo de encuesta y documentarla.
- **Hecho (2026-11-07).** Un proyecto **nuevo** nace con 365 días (la organización lo cambia o lo
  deja vacío a sabiendas) y la pantalla de ajustes avisa en ámbar cuando no hay plazo. Los
  proyectos que ya existen **no se tocan**: borrar datos no debe empezar solo. _Pendiente:_
  revisar uno a uno los proyectos existentes.
- **Ya hecho.** La Política de Privacidad ahora dice la verdad: «si no lo fija, los datos se
  conservan hasta que la organización los borre».

## 2. Sin aviso informativo obligatorio al recoger datos

- **Qué vi.** Solo la política enlazada al pie de las encuestas web (añadida hoy). No hay un
  paso previo, obligatorio y registrado, que diga quién es el responsable, para qué se usan los
  datos, que participar es voluntario y cómo ejercer derechos. En llamadas y visitas depende de
  que el guion del proyecto lo diga. Existe un mecanismo parecido solo para la grabación de audio
  (texto de consentimiento con versión, guardado como paradato).
- **Por qué importa.** El deber de informar al recoger los datos y, donde la base es el
  consentimiento, poder demostrarlo, es el punto más sancionado de estas leyes.
- **Qué hacer.** _Desarrollo:_ un ajuste de proyecto «aviso informativo» (texto, versión,
  idioma) que se muestre antes de la primera pregunta en web, aparezca como guion obligatorio en
  CATI/CAPI y se guarde con cada entrevista (como ya se hace con el audio). _Organización:_
  redactar el texto con su área jurídica.
- **Hecho (2026-11-08).** El aviso es **parte del cuestionario**, su primera pregunta: un texto de
  consentimiento más la pregunta que acepta o rechaza, y un rechazo termina la entrevista como
  tal. El botón «Aviso informativo» del diseñador agrega el par estándar en cada idioma del
  cuestionario; se traduce, se ve en la vista previa, se imprime en papel y se exporta como
  cualquier elemento, y su versión es la del cuestionario. Un proyecto puede **exigirlo**
  (Ajustes → Privacidad): no se publica un cuestionario que no empiece con él. _Pendiente:_
  completar el texto (organización, finalidad, contacto) en cada cuestionario con el área
  jurídica.

## 3. Contacto telefónico sin base legal declarada ni listas nacionales de exclusión

- **Qué vi.** Para correo y SMS la aplicación **no envía nada** hasta que el proyecto declara su
  base legal (`cawi.service.ts`). Para llamadas (CATI) y visitas (CAPI) no hay equivalente. Sí
  respeta el registro propio de personas que no quieren ser contactadas, el horario de llamadas
  por zona horaria y la opción «no volver a llamar». No contrasta con **listas nacionales de
  exclusión** (tipo «no llamar»), que en varios países obligan también a las encuestas cuando
  hay fin comercial o de mercadeo.
- **Por qué importa.** Llamar o escribir sin base o contra una lista de exclusión expone a
  sanciones administrativas y a reclamaciones civiles por molestias; con fines comerciales puede
  ser infracción grave.
- **Qué hacer.** _Desarrollo:_ exigir la base legal también para teléfono y visita; reutilizar la
  carga CSV del registro para importar listas nacionales y marcar su origen. _Organización:_
  determinar si la encuesta está exenta (investigación o estadística) o no, y por escrito.

- **Hecho (2026-11-07).** Ajuste «Base legal para llamar y visitar» (Ajustes → Privacidad), una
  para el teléfono y otra para las visitas. Mientras no esté declarada, **no se puede llamar**
  (pedir el siguiente caso), **empezar una entrevista de ese canal ni descargar casos a una
  tableta**: el servidor responde 409 `NO_LAWFUL_BASIS` y la pantalla explica qué falta. Correo
  y SMS ya lo exigían. _Atención al actualizar:_ los proyectos existentes que llaman o visitan
  quedan **bloqueados hasta que se declare**, a propósito. _Pendiente:_ importar listas
  nacionales de exclusión (la carga CSV del registro ya sirve; falta marcar su origen) y que el
  informe de campo muestre la base declarada.

## 4. Geocodificación con un servicio público gratuito (OpenStreetMap)

- **Qué vi.** Apagada por defecto (`GEOCODER=none`). Si se enciende, las **direcciones de las
  personas de la muestra** se envían a `nominatim.openstreetmap.org`, hasta 5 000 por solicitud a
  una por segundo (`geocoder.ts`, `GEOCODE_MAX`). Además el mapa de casos pide las teselas a
  `tile.openstreetmap.org`, con lo que ese servicio ve la dirección IP del personal y la zona
  que mira (`CaseMap.tsx`; la atribución sí está).
- **Por qué importa.** (a) Es una **cesión de datos personales a un tercero** sin contrato de
  encargo ni garantías. (b) La política de uso del servicio público prohíbe el uso intensivo y la
  geocodificación masiva; un incumplimiento puede acabar en bloqueo del servicio en pleno campo
  y es un incumplimiento contractual de sus términos.
- **Qué hacer.** _Organización:_ para muestras reales usar un Nominatim propio o un proveedor
  comercial con contrato de encargo. _Desarrollo:_ permitir cambiar las teselas del mapa a un
  proveedor configurable y poner un tope bajo por defecto a `GEOCODE_MAX` con aviso en pantalla.

## 5. Datos sensibles y menores sin controles específicos

- **Qué vi.** Un cuestionario puede preguntar cualquier cosa (salud, ideología, origen étnico,
  orientación sexual, religión, situación judicial). La aplicación solo distingue «personal» o
  no (`personal: true`): cifra, oculta y excluye de exportaciones. No hay marca de «dato
  sensible» con controles más fuertes ni una pregunta de edad que excluya a menores
  automáticamente.
- **Por qué importa.** Los datos sensibles y los de menores tienen régimen reforzado
  (consentimiento expreso, evaluación de impacto, a veces prohibición); un error aquí es de las
  infracciones más graves.
- **Qué hacer.** _Desarrollo:_ marca «sensible» por pregunta (con aviso al diseñar, exigencia de
  aviso informativo específico, exclusión por defecto de las exportaciones y del modelo de BI) y
  plantilla de «pregunta de edad con salida». _Organización:_ evaluación de impacto antes de
  cualquier encuesta con datos sensibles o de menores; consentimiento del tutor cuando proceda.

## 6. Sin procedimiento de respuesta a incidentes de seguridad

- **Qué vi.** Ninguna guía de incidentes en `docs/` (la búsqueda de «incidente» o «brecha» solo
  encuentra una nota sobre contraseñas filtradas). Sí hay buenas herramientas de investigación:
  registro de auditoría que la aplicación solo puede ampliar, quién vio datos personales y qué
  se exportó.
- **Por qué importa.** Casi todos los regímenes obligan a **notificar a la autoridad y a los
  afectados** en plazos cortos (en Europa, 72 horas). Sin procedimiento, el plazo se pierde y la
  responsabilidad se agrava.
- **Qué hacer.** _Organización:_ un protocolo escrito (quién decide, a quién se avisa, plantilla
  de aviso, plazos, quién contacta a la autoridad), con un ensayo al año. _Desarrollo:_ añadir
  a `docs/operations.md` los pasos técnicos (cortar sesiones, rotar la clave, consultas al
  registro de auditoría).

## 7. Vigilancia de entrevistadores (posición, calidad, riesgo, voz)

- **Qué vi.** Si el proyecto lo activa, se registra la posición del dispositivo al empezar y al
  terminar cada entrevista (`useInterview.ts`, ajuste `capi.gps` con un texto de aviso
  configurable) y, con grabación activa, la voz. Se calculan indicadores de calidad por entrevista
  y una **puntuación de riesgo** por entrevista y por entrevistador, de la que depende la cola de
  revisión. Hay revisión humana; el sistema no rechaza solo.
- **Por qué importa.** Es **monitorización de personas trabajadoras**: exige informarles
  previamente, que sea proporcionada y, según el país, consulta con representantes o base
  laboral específica. Si alguien perdiera su empleo o su pago por una puntuación sin revisión
  humana, es una decisión automatizada con efectos jurídicos.
- **Qué hacer.** _Organización:_ cláusula en el contrato o anexo de trabajo y aviso a cada
  entrevistador; documentar que ninguna medida disciplinaria se basa solo en la puntuación.
  _Desarrollo:_ mostrar el aviso al entrevistador en el primer acceso y registrar su aceptación.
- **Ya hecho.** La política ahora informa de esto en la sección de personal que usa la aplicación.

## 8. Seguimiento de aperturas de correo sin opción de apagarlo

- **Qué vi.** Cada correo lleva un píxel de apertura y enlaces con seguimiento
  (`cawi.service.ts`); no hay ajuste para desactivarlos. Sí lleva cabecera y enlace de baja.
- **Por qué importa.** En Europa y otros países, el seguimiento de aperturas se considera
  almacenamiento o acceso a información del dispositivo y necesita consentimiento (directiva de
  privacidad electrónica).
- **Qué hacer.** _Desarrollo:_ ajuste por proyecto «medir aperturas» (apagado por defecto en
  proyectos que lo declaren necesario) manteniendo el seguimiento de clics necesario para el
  enlace personal.

## 9. Registro de auditoría sin plazo; copias de seguridad

- **Qué vi.** El registro de auditoría guarda correos de personal y direcciones IP y **no tiene
  purga** (la aplicación solo puede añadir). Las copias de seguridad se guardan 30 días
  (`docs/operations.md`) y contienen datos que después se borren o anonimicen en la base viva.
- **Por qué importa.** La conservación del registro debe tener plazo razonable y justificado
  (seguridad, defensa jurídica). Y si se **restaura una copia**, reaparecen datos ya borrados: es
  un incumplimiento del derecho de supresión.
- **Qué hacer.** _Desarrollo:_ plazo configurable del registro (por ejemplo 24 meses) con un
  trabajo de purga con permisos propios; guardar un **registro de supresiones** para volver a
  aplicarlas tras una restauración. _Organización:_ fijar los plazos y documentarlos.

## 10. Sin términos de uso ni compromiso de confidencialidad del personal

- **Qué vi.** Ninguna pantalla de términos ni de aceptación de confidencialidad para quien usa
  la aplicación (búsqueda sin resultados).
- **Por qué importa.** La mayor parte de las fugas nacen del personal interno (acceso indebido,
  exportación y envío fuera). Sin compromiso firmado ni aceptado, es difícil exigir
  responsabilidades civiles o penales (revelación de secretos, acceso indebido a datos).
- **Qué hacer.** _Desarrollo:_ aceptación de términos y confidencialidad en el primer acceso,
  con versión y fecha, y reaceptación al cambiar. _Organización:_ redactar los términos
  (uso aceptable, prohibición de copiar datos, consecuencias) y firmar contrato de encargo con
  quien actúe como encargado.

## 11. Enlaces para compartir resultados que pueden no caducar

- **Qué vi.** Los enlaces públicos de resúmenes tienen 30 días por defecto, pero el plazo puede
  quedar vacío (`share.service.ts`, `days` nulo), es decir, **sin caducidad**. Crear y descargar
  quedan en el registro.
- **Por qué importa.** Un enlace sin caducidad es una puerta abierta permanente a información
  que puede incluir datos pequeños de grupos identificables.
- **Qué hacer.** _Desarrollo:_ tope máximo (por ejemplo 90 días), aviso al crearlo y una lista
  para revocar. Comprobar que los resúmenes compartidos nunca contienen respuestas marcadas como
  personales ni celdas con muy pocas personas.

## 12. Seguridad: lo que falta para poder decir «razonablemente protegido»

La base es buena (ASVS nivel 2, cifrado de campos personales, aislamiento por organización en la
base de datos, permisos por rol probados). Quedan estos puntos, ya listados como parciales en
`docs/security.md`:

- Sin prueba de penetración independiente. _Organización:_ contratarla antes de producción con
  datos reales y guardar el informe.
- Clave de cifrado única, sin rotación implementada; perderla vuelve ilegibles los datos
  personales. _Organización:_ gestor de secretos y copia separada; _Desarrollo:_ rotación.
- Segundo factor obligatorio solo para administradores. _Desarrollo:_ ofrecerlo obligatorio para
  quien tenga permiso de ver datos personales o exportar.
- Contraseñas filtradas no se comprueban. _Desarrollo:_ comprobación con un servicio que no
  reciba la contraseña completa.
- TLS y cifrado de disco dependen del despliegue. _Organización:_ verificarlos y documentarlo.

**Responsabilidad.** La documentación de seguridad describe medidas, no garantías. Evitar
promesas de «seguridad total» en contratos y materiales; lo exigible es un nivel razonable según
el estado de la técnica y el riesgo.

## 13. Texto de la Política de Privacidad inexacto — Corregido

Dos afirmaciones no coincidían con el código y ya se corrigieron en
`apps/web/src/about/content.ts`:

1. Decía que las encuestas **web** registraban la posición del dispositivo. No es así: solo el
   dispositivo del entrevistador en entrevistas con entrevistador, si el proyecto lo activa.
2. Decía que cada proyecto fija un plazo de conservación; por defecto no hay plazo (hallazgo 1).

También se añadieron las medidas sobre el personal (posición, voz, indicadores de calidad) y los
servicios de notificaciones del navegador. **Una política inexacta es en sí un riesgo**
(publicidad engañosa o infracción del deber de información): por eso conviene revisarla con cada
cambio funcional. Este documento y los textos deben mantenerse juntos.

## 14. Licencias, propiedad intelectual y atribuciones

- No hay archivo `LICENSE` en el repositorio. Sin él, el software queda «todos los derechos
  reservados», lo cual es válido pero debe estar claro en el contrato (quién es el titular, qué
  puede hacer el cliente, quién da el mantenimiento).
- Las dependencias de producción (300 paquetes) son todas permisivas (MIT, Apache-2.0, ISC,
  BSD, 0BSD, Unlicense, Python-2.0); **ninguna copyleft**. La fuente Poppins se distribuye bajo
  OFL y el texto de la licencia está incluido.
- Atribuciones: OpenStreetMap figura en el mapa; los botones de Microsoft deben seguir sus
  pautas de marca. _Organización:_ añadir una cláusula de propiedad y licencia, y generar una
  lista de componentes (SBOM) en cada versión.

## 15. Obligaciones administrativas fuera del código

La aplicación no puede cumplirlas, pero su ausencia es lo que más suele sancionarse. Confirme
con su área jurídica cuáles aplican en su país:

- **Responsable y encargado.** Quién es responsable del tratamiento y quién encargado
  (proveedor de la aplicación, de alojamiento, de correo, de SMS); contratos de encargo con cada
  uno.
- **Registro de actividades de tratamiento** y, donde se exija, **inscripción de las bases de
  datos** en el registro de la autoridad.
- **Evaluación de impacto** para encuestas con datos sensibles, menores, vigilancia o gran
  escala.
- **Delegado o responsable de protección de datos**, si la ley o el tamaño lo exigen.
- **Canal de derechos** (acceso, rectificación, supresión, oposición) con plazo de respuesta
  interno; la aplicación ya permite exportar y borrar los datos de una persona desde un caso.
- **Transferencias internacionales:** región de alojamiento y garantías si está fuera del país.
- **Autoridad competente** a la que reclamar: debe aparecer en la política cuando se publique.
- **Propiedad de los datos y plazos de entrega** con el contratante final de la encuesta
  (quién es responsable, quién conserva, qué se entrega y cuándo se destruye).
- **Seguro** de responsabilidad civil y ciberriesgo adecuado al volumen de datos.

## Responsabilidades en tres planos

- **Civil:** daños por fuga, por llamadas o mensajes no deseados, por tratamiento sin base o por
  conservar de más; también por decisiones basadas en datos falsos o mal procesados (por ejemplo
  una estadística que sirva para asignar recursos). Mitigan: contratos de encargo, avisos
  registrados, plazos de conservación, controles de calidad y seguro.
- **Penal:** el acceso o la revelación indebida de datos por parte del personal, la interceptación
  de comunicaciones (la aplicación **no graba llamadas**; la grabación de audio de CAPI solo
  existe con consentimiento y está apagada por defecto), el envío masivo no consentido, la
  falsificación de entrevistas o datos en estadísticas oficiales, y el acceso indebido a sistemas.
  Mitigan: roles mínimos (`pii.view` solo a quien lo necesita), compromisos de confidencialidad,
  registro de auditoría y la revisión de calidad que ya existe.
- **Administrativa:** sanciones de la autoridad de protección de datos o de consumo y
  telecomunicaciones por los puntos 1 a 6, 8 y 15. Mitigan: lo mismo, más documentación que
  demuestre diligencia (esta revisión es parte de ella).

## Qué se hizo en esta revisión y qué sigue

- Corregidos los dos puntos inexactos de la política y ampliada la información al personal.
- Pendiente de desarrollo, por orden sugerido: 2 (aviso informativo), 1 (plazo obligatorio),
  3 (base legal para teléfono y visita), 5 (dato sensible), 8 (medir aperturas), 9 (plazo del
  registro y supresiones tras restaurar), 10 (términos), 11 (tope de enlaces), 4 (teselas y tope
  de geocodificación).
- Pendiente de la organización: 6, 15 y los puntos marcados «Organización».

Revise este documento en cada versión que cambie lo que se recoge, para quién o por qué canal.
