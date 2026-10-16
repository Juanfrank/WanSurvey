/**
 * The (i) explanations of the sampling selector (S1): what each term means and the usual
 * standard to start from. Loaded with the selector's other words (`cases.sampling.tips`).
 */
export const tipsEn = {
  // Layer 1
  source: {
    text: 'Where the units (people, households, firms…) that can enter the sample come from.',
    std: 'An imported frame (a complete, up-to-date list) whenever one exists; it is the only source that allows a probability sample without field listing.',
  },
  unit: {
    text: 'The sampling unit: what is selected and becomes one case (a household, a person, a firm, a school…).',
    std: 'Name it plainly and keep it equal to the unit of analysis, or say how the person within it is chosen (e.g. the adult with the next birthday).',
  },
  populationKnown: {
    text: 'The population size N: how many units exist in total. It is a separate fact from having a list of them.',
    std: 'Use an official figure (census, register) when you have one. It only changes the sample size when the sample is more than about 5% of N.',
  },
  frameAvailable: {
    text: 'The sampling frame: a list from which units can be drawn one by one. Probability designs need one (or an area frame).',
    std: 'Check coverage before using it: units missing from the list can never be selected (coverage bias).',
  },
  // Layer 2
  family: {
    text: 'Probability designs give every unit a known chance of selection; non-probability designs do not, so their results cannot carry a margin of error by design.',
    std: 'Probability sampling for estimates you will generalise; non-probability for exploratory, hard-to-reach or quick studies, said plainly in the report.',
  },
  srs: {
    text: 'Simple random sampling: every set of n units has the same chance. Each unit has probability n/N.',
    std: 'The reference design: use it when the list has no useful order or groups.',
  },
  systematic: {
    text: 'Systematic sampling: a random start and then every k-th unit (k = N/n) of the list.',
    std: 'Sort the list by a meaningful variable (region, size) first: it spreads the sample like implicit stratification. Avoid lists with periodic patterns.',
  },
  stratified: {
    text: 'Stratified sampling: the list is split into groups (strata) and units are drawn within each one.',
    std: 'Stratify by variables related to what you measure (region, urban/rural). Keep at least 2 units per stratum to estimate variance.',
  },
  cluster: {
    text: 'Cluster sampling: groups (blocks, schools, villages) are drawn, then units within them. Cheaper in the field but less precise.',
    std: 'Prefer many small clusters to few large ones; at least 20–30 clusters. Set the design effect above 1 (often 1.5–2).',
  },
  multistage: {
    text: 'Multistage sampling: strata, then clusters (primary units) in each stratum, then units within each cluster.',
    std: 'The usual design for national household surveys: PPS selection of clusters and a fixed number of households per cluster (8–15).',
  },
  quota: {
    text: 'Quota sampling: units are taken until targets per cell (e.g. sex × age) are filled. Not random: inclusion probabilities are unknown.',
    std: 'Base the cells on official population figures and report it as a non-probability sample, without a margin of error.',
  },
  convenience: {
    text: 'Convenience sampling: whoever is easy to reach (volunteers, passers-by, a contact list).',
    std: 'Only for pilots and exploratory work; never present its results as representative.',
  },
  purposive: {
    text: 'Purposive (judgement) sampling: units chosen deliberately for what they are (experts, typical or extreme cases).',
    std: 'Write down the selection criteria; usual in qualitative and expert studies.',
  },
  snowball: {
    text: 'Snowball sampling: each participant refers others. For hidden or rare populations without a list.',
    std: 'Start from several varied seeds and limit referrals per person; consider respondent-driven sampling if you need estimates.',
  },
  adaptive: {
    text: 'Adaptive sampling: the sample grows around units where the trait is found (e.g. neighbours of a positive case).',
    std: 'For rare and clustered traits; plan the rule for adding units before fieldwork.',
  },
  timelocation: {
    text: 'Time-location sampling: places and time slots are listed and drawn, and people present then are interviewed.',
    std: 'For mobile populations (markets, transport, venues): list the venue × time slots and draw them at random.',
  },
  other: {
    text: 'Another documented method compatible with the study (e.g. web panels, mixed designs).',
    std: 'Describe it in full so it can be reproduced and weighted.',
  },
  census: {
    text: 'Census: every eligible unit of the list is interviewed; there is no selection and no sampling error.',
    std: 'Use it when the list is small or every unit matters; results still depend on coverage and response.',
  },
  strataVar: {
    text: 'The frame column that defines the strata (e.g. region).',
    std: 'A variable known for every unit and related to the main results; avoid strata with fewer than 2 units.',
  },
  clusterVar: {
    text: 'The frame column that groups units into clusters (e.g. block or village code).',
    std: 'A code that every unit has; clusters should be similar in size or selected with PPS.',
  },
  sizeVar: {
    text: 'Size measure for PPS (probability proportional to size): larger clusters get a larger chance of selection.',
    std: 'Number of households or people per cluster from the latest census.',
  },
  sortVar: {
    text: 'The order of the list before taking every k-th unit (implicit stratification).',
    std: 'Geographic order or a size variable; never an order that repeats in cycles.',
  },
  allocation: {
    text: 'How the sample is shared among strata. Proportional: as in the population. Equal: the same number per stratum. Manual: you set each one.',
    std: 'Proportional for national estimates; equal (or a minimum per stratum) when each stratum must be reported on its own. Weights then correct the shares.',
  },
  within: {
    text: 'How units are drawn inside each stratum: simple random or systematic.',
    std: 'Systematic over a sorted list spreads the sample better; simple random when the list has no order.',
  },
  clusters: {
    text: 'How many clusters (primary units) are drawn, in all or per stratum.',
    std: 'At least 20–30 clusters overall, and 2 or more per stratum.',
  },
  perCluster: {
    text: 'How many units are taken in each selected cluster (0 = all of them).',
    std: '8–15 households per cluster in household surveys; fewer per cluster lowers the design effect.',
  },
  pps: {
    text: 'Probability proportional to size: a cluster’s chance of selection follows its size; with a fixed number per cluster, every unit ends with a similar probability (self-weighting).',
    std: 'Recommended when clusters differ a lot in size.',
  },
  quotas: {
    text: 'Targets per cell (e.g. women 18–29). In a probability design they monitor the sample; in a quota design they are how units are selected.',
    std: 'Never replace selected units to fill a quota in a probability sample; correct with weights instead.',
  },
  // Layer 3
  objective: {
    text: 'What the sample must estimate, which decides the formula for its size.',
    std: 'A proportion (the most common case); a mean for amounts; a difference when comparing two groups; a fixed size when budget decides.',
  },
  confidence: {
    text: 'Confidence level: how often intervals built this way contain the true value.',
    std: '95% (z = 1.96). 90% for quick or low-stakes studies; 99% when errors are costly.',
  },
  margin: {
    text: 'Margin of error: the half-width of the confidence interval (± points) you accept for the estimate.',
    std: '±3 to ±5 percentage points for national figures; ±5 to ±10 for subgroups or small studies.',
  },
  p: {
    text: 'Expected proportion of the main result. The sample is largest when p = 50%.',
    std: '50% when unknown (the most conservative choice); otherwise a previous study’s value.',
  },
  marginMean: {
    text: 'Margin of error for a mean, in the units of the variable (e.g. ±500 pesos).',
    std: 'About 5–10% of the expected mean.',
  },
  sd: {
    text: 'Standard deviation of the variable: how spread its values are. Needed to size a mean.',
    std: 'From a previous survey or pilot; if unknown, about (maximum − minimum) / 4.',
  },
  p1: {
    text: 'Expected proportion in the first group being compared.',
    std: 'From previous data; the closer to 50%, the larger the sample.',
  },
  p2: {
    text: 'Expected proportion in the second group: the smallest difference worth detecting.',
    std: 'A difference of 5–10 points is typical; smaller differences need much larger samples.',
  },
  power: {
    text: 'Statistical power: the chance of detecting the difference if it really exists.',
    std: '80% (90% for confirmatory studies).',
  },
  deff: {
    text: 'Design effect: how much the design increases the variance compared with simple random sampling (1 = same).',
    std: '1 for simple random or stratified; 1.5–2 for cluster and multistage designs; take it from a similar earlier survey if you can.',
  },
  fixedN: {
    text: 'The number of completed interviews you aim for, set directly (budget or contract).',
    std: 'Check what margin of error it gives: about ±1/√n (n = 400 → ±5 points at 95%).',
  },
  eligibilityRate: {
    text: 'Share of selected units expected to be eligible (e.g. occupied dwellings, people in the target group).',
    std: 'From the frame’s quality or earlier fieldwork; 85–95% for good household lists.',
  },
  responseRate: {
    text: 'Share of eligible units expected to complete the interview.',
    std: 'Plan from similar studies: often 50–70% face to face, 20–40% by phone, lower on the web.',
  },
  reserveRate: {
    text: 'Extra units selected in reserve, released only by decision if response falls short.',
    std: '10–20% of the main sample. Release reserves in their random order, whole, never one by one to replace refusals.',
  },
  fpc: {
    text: 'Finite population correction: when the sample is a large share of the population, fewer units are needed.',
    std: 'Applied when N is known; it matters when n is more than about 5% of N.',
  },
  sizes: {
    text: 'Three different numbers: the completes the objective needs; the units to select so that, after eligibility and non-response, that many remain; and the cases to manage in the field, reserves included.',
    std: 'Selected = required ÷ (eligibility × response); cases = selected + reserves.',
  },
  eligibility: {
    text: 'Rule on the frame’s columns that decides who can be in the sample (e.g. case.age >= 18).',
    std: 'Match the study’s target population exactly; empty means every unit.',
  },
  exclusions: {
    text: 'Eligible units left out on purpose (e.g. inaccessible areas). They reduce coverage.',
    std: 'Keep them few and report them with the results.',
  },
  substitution: {
    text: 'Substitution: replacing a unit that cannot be interviewed. Done here only by a predefined rule, recorded on both cases.',
    std: 'Avoid it in probability samples (it can bias results); prefer releasing reserves. If used, only for final non-contact or refusal.',
  },
  rule: {
    text: 'Which reserve replaces the unit: one from the same stratum, or the next reserve in order.',
    std: 'Same stratum keeps the design’s balance.',
  },
  reasons: {
    text: 'The final results that allow a substitute.',
    std: 'Refusal and non-contact after the planned number of visits or calls; never ineligibility.',
  },
};

export const tipsEs: typeof tipsEn = {
  source: {
    text: 'De dónde salen las unidades (personas, hogares, empresas…) que pueden entrar en la muestra.',
    std: 'Un marco importado (una lista completa y actualizada) siempre que exista; es la única fuente que permite una muestra probabilística sin listado en campo.',
  },
  unit: {
    text: 'La unidad de muestreo: lo que se selecciona y se convierte en un caso (un hogar, una persona, una empresa, una escuela…).',
    std: 'Nómbrela con claridad y que coincida con la unidad de análisis, o indique cómo se elige a la persona dentro de ella (p. ej. el adulto que cumpla años primero).',
  },
  populationKnown: {
    text: 'El tamaño de la población N: cuántas unidades existen en total. Es un dato distinto de tener una lista de ellas.',
    std: 'Use una cifra oficial (censo, registro) si la tiene. Solo cambia el tamaño de muestra cuando la muestra supera cerca del 5 % de N.',
  },
  frameAvailable: {
    text: 'El marco muestral: una lista de la que se pueden sacar las unidades una a una. Los diseños probabilísticos lo necesitan (o un marco de áreas).',
    std: 'Revise su cobertura antes de usarlo: las unidades que faltan en la lista nunca podrán ser seleccionadas (sesgo de cobertura).',
  },
  family: {
    text: 'Los diseños probabilísticos dan a cada unidad una probabilidad conocida de selección; los no probabilísticos no, por eso sus resultados no llevan un margen de error garantizado por el diseño.',
    std: 'Probabilístico para estimaciones que se generalizarán; no probabilístico para estudios exploratorios, de difícil acceso o rápidos, dicho con claridad en el informe.',
  },
  srs: {
    text: 'Muestreo aleatorio simple: todo conjunto de n unidades tiene la misma probabilidad. Cada unidad tiene probabilidad n/N.',
    std: 'El diseño de referencia: úselo cuando la lista no tiene un orden ni grupos útiles.',
  },
  systematic: {
    text: 'Muestreo sistemático: un arranque aleatorio y luego una de cada k unidades (k = N/n) de la lista.',
    std: 'Ordene antes la lista por una variable con sentido (región, tamaño): reparte la muestra como una estratificación implícita. Evite listas con patrones periódicos.',
  },
  stratified: {
    text: 'Muestreo estratificado: la lista se divide en grupos (estratos) y se seleccionan unidades dentro de cada uno.',
    std: 'Estratifique por variables relacionadas con lo que mide (región, urbano/rural). Deje al menos 2 unidades por estrato para estimar la varianza.',
  },
  cluster: {
    text: 'Muestreo por conglomerados: se seleccionan grupos (manzanas, escuelas, comunidades) y luego unidades dentro de ellos. Más barato en campo pero menos preciso.',
    std: 'Prefiera muchos conglomerados pequeños a pocos grandes; al menos 20–30. Fije el efecto de diseño por encima de 1 (a menudo 1.5–2).',
  },
  multistage: {
    text: 'Muestreo multietápico: estratos, luego conglomerados (unidades primarias) en cada estrato y luego unidades dentro de cada conglomerado.',
    std: 'El diseño habitual de las encuestas nacionales de hogares: conglomerados con PPT y un número fijo de hogares por conglomerado (8–15).',
  },
  quota: {
    text: 'Muestreo por cuotas: se toman unidades hasta llenar metas por celda (p. ej. sexo × edad). No es aleatorio: las probabilidades de inclusión se desconocen.',
    std: 'Base las celdas en cifras oficiales de la población e infórmelo como muestra no probabilística, sin margen de error.',
  },
  convenience: {
    text: 'Muestreo por conveniencia: quien es fácil de alcanzar (voluntarios, transeúntes, una lista de contactos).',
    std: 'Solo para pilotos y trabajos exploratorios; nunca presente sus resultados como representativos.',
  },
  purposive: {
    text: 'Selección intencional (por juicio): unidades elegidas a propósito por lo que son (expertos, casos típicos o extremos).',
    std: 'Deje por escrito los criterios de selección; habitual en estudios cualitativos y de expertos.',
  },
  snowball: {
    text: 'Bola de nieve: cada participante refiere a otros. Para poblaciones ocultas o raras sin lista.',
    std: 'Empiece con varias semillas diversas y limite los referidos por persona; considere el muestreo dirigido por el entrevistado (RDS) si necesita estimaciones.',
  },
  adaptive: {
    text: 'Selección adaptativa: la muestra crece alrededor de las unidades donde se encuentra la característica (p. ej. los vecinos de un caso positivo).',
    std: 'Para características raras y agrupadas; defina la regla para agregar unidades antes del campo.',
  },
  timelocation: {
    text: 'Muestreo por tiempo y lugar: se listan lugares y franjas horarias, se seleccionan y se entrevista a quienes están presentes.',
    std: 'Para poblaciones móviles (mercados, transporte, locales): liste las combinaciones lugar × franja y selecciónelas al azar.',
  },
  other: {
    text: 'Otro método documentado y compatible con el estudio (p. ej. paneles web, diseños mixtos).',
    std: 'Descríbalo completo para que pueda reproducirse y ponderarse.',
  },
  census: {
    text: 'Censo: se entrevista a todas las unidades elegibles de la lista; no hay selección ni error muestral.',
    std: 'Úselo cuando la lista es pequeña o cada unidad importa; los resultados igual dependen de la cobertura y la respuesta.',
  },
  strataVar: {
    text: 'La columna del marco que define los estratos (p. ej. región).',
    std: 'Una variable conocida para todas las unidades y relacionada con los resultados principales; evite estratos con menos de 2 unidades.',
  },
  clusterVar: {
    text: 'La columna del marco que agrupa las unidades en conglomerados (p. ej. código de manzana o comunidad).',
    std: 'Un código que todas las unidades tengan; los conglomerados deben ser de tamaño parecido o seleccionarse con PPT.',
  },
  sizeVar: {
    text: 'Medida de tamaño para PPT (probabilidad proporcional al tamaño): los conglomerados más grandes tienen más probabilidad de ser seleccionados.',
    std: 'Número de hogares o personas por conglomerado según el último censo.',
  },
  sortVar: {
    text: 'El orden de la lista antes de tomar una de cada k unidades (estratificación implícita).',
    std: 'Orden geográfico o una variable de tamaño; nunca un orden que se repita en ciclos.',
  },
  allocation: {
    text: 'Cómo se reparte la muestra entre estratos. Proporcional: como en la población. Igual: el mismo número por estrato. Manual: usted fija cada uno.',
    std: 'Proporcional para estimaciones nacionales; igual (o un mínimo por estrato) cuando cada estrato debe informarse por separado. Luego los pesos corrigen las proporciones.',
  },
  within: {
    text: 'Cómo se seleccionan las unidades dentro de cada estrato: aleatorio simple o sistemático.',
    std: 'El sistemático sobre una lista ordenada reparte mejor la muestra; aleatorio simple cuando la lista no tiene orden.',
  },
  clusters: {
    text: 'Cuántos conglomerados (unidades primarias) se seleccionan, en total o por estrato.',
    std: 'Al menos 20–30 conglomerados en total y 2 o más por estrato.',
  },
  perCluster: {
    text: 'Cuántas unidades se toman en cada conglomerado seleccionado (0 = todas).',
    std: '8–15 hogares por conglomerado en encuestas de hogares; menos por conglomerado reduce el efecto de diseño.',
  },
  pps: {
    text: 'Probabilidad proporcional al tamaño (PPT): la probabilidad de un conglomerado sigue su tamaño; con un número fijo por conglomerado, todas las unidades terminan con una probabilidad parecida (autoponderada).',
    std: 'Recomendado cuando los conglomerados difieren mucho de tamaño.',
  },
  quotas: {
    text: 'Metas por celda (p. ej. mujeres de 18–29). En un diseño probabilístico vigilan la muestra; en uno por cuotas son la forma de seleccionar.',
    std: 'En una muestra probabilística nunca reemplace unidades seleccionadas para llenar una cuota; corrija con pesos.',
  },
  objective: {
    text: 'Lo que la muestra debe estimar, que decide la fórmula de su tamaño.',
    std: 'Una proporción (el caso más común); una media para montos; una diferencia al comparar dos grupos; un tamaño fijo cuando decide el presupuesto.',
  },
  confidence: {
    text: 'Nivel de confianza: con qué frecuencia los intervalos construidos así contienen el valor verdadero.',
    std: '95 % (z = 1.96). 90 % para estudios rápidos o de bajo riesgo; 99 % cuando los errores son costosos.',
  },
  margin: {
    text: 'Margen de error: la mitad del ancho del intervalo de confianza (± puntos) que acepta para la estimación.',
    std: '±3 a ±5 puntos porcentuales para cifras nacionales; ±5 a ±10 para subgrupos o estudios pequeños.',
  },
  p: {
    text: 'Proporción esperada del resultado principal. La muestra es mayor cuando p = 50 %.',
    std: '50 % si se desconoce (la opción más conservadora); si no, el valor de un estudio anterior.',
  },
  marginMean: {
    text: 'Margen de error para una media, en las unidades de la variable (p. ej. ±500 pesos).',
    std: 'Cerca del 5–10 % de la media esperada.',
  },
  sd: {
    text: 'Desviación estándar de la variable: qué tan dispersos son sus valores. Se necesita para dimensionar una media.',
    std: 'De una encuesta o piloto anterior; si se desconoce, aproximadamente (máximo − mínimo) / 4.',
  },
  p1: {
    text: 'Proporción esperada en el primer grupo que se compara.',
    std: 'De datos anteriores; cuanto más cerca del 50 %, mayor la muestra.',
  },
  p2: {
    text: 'Proporción esperada en el segundo grupo: la diferencia más pequeña que vale la pena detectar.',
    std: 'Una diferencia de 5–10 puntos es típica; diferencias menores requieren muestras mucho más grandes.',
  },
  power: {
    text: 'Potencia estadística: la probabilidad de detectar la diferencia si realmente existe.',
    std: '80 % (90 % para estudios confirmatorios).',
  },
  deff: {
    text: 'Efecto de diseño: cuánto aumenta el diseño la varianza respecto del muestreo aleatorio simple (1 = igual).',
    std: '1 para aleatorio simple o estratificado; 1.5–2 para diseños por conglomerados y multietápicos; tómelo de una encuesta anterior parecida si puede.',
  },
  fixedN: {
    text: 'El número de entrevistas completas que busca, fijado directamente (presupuesto o contrato).',
    std: 'Revise qué margen de error da: cerca de ±1/√n (n = 400 → ±5 puntos al 95 %).',
  },
  eligibilityRate: {
    text: 'Proporción de unidades seleccionadas que se espera sean elegibles (p. ej. viviendas ocupadas, personas del grupo objetivo).',
    std: 'Según la calidad del marco o campos anteriores; 85–95 % para buenas listas de hogares.',
  },
  responseRate: {
    text: 'Proporción de unidades elegibles que se espera completen la entrevista.',
    std: 'Planifique con estudios similares: a menudo 50–70 % presencial, 20–40 % telefónico, menos en web.',
  },
  reserveRate: {
    text: 'Unidades adicionales seleccionadas como reserva, que se liberan solo por decisión si la respuesta no alcanza.',
    std: '10–20 % de la muestra principal. Libere las reservas en su orden aleatorio y por bloques, nunca una a una para reemplazar rechazos.',
  },
  fpc: {
    text: 'Corrección por población finita: cuando la muestra es una parte grande de la población, se necesitan menos unidades.',
    std: 'Se aplica cuando N es conocido; importa cuando n supera cerca del 5 % de N.',
  },
  sizes: {
    text: 'Tres números distintos: las entrevistas completas que pide el objetivo; las unidades a seleccionar para que, tras la elegibilidad y la no respuesta, queden esas; y los casos a gestionar en campo, con las reservas.',
    std: 'Seleccionadas = requeridas ÷ (elegibilidad × respuesta); casos = seleccionadas + reservas.',
  },
  eligibility: {
    text: 'Regla sobre las columnas del marco que decide quién puede estar en la muestra (p. ej. case.age >= 18).',
    std: 'Que coincida exactamente con la población objetivo del estudio; vacía significa todas las unidades.',
  },
  exclusions: {
    text: 'Unidades elegibles que se dejan fuera a propósito (p. ej. zonas inaccesibles). Reducen la cobertura.',
    std: 'Que sean pocas e infórmelas junto con los resultados.',
  },
  substitution: {
    text: 'Sustitución: reemplazar una unidad que no se puede entrevistar. Aquí solo se hace por una regla fijada antes y queda registrada en ambos casos.',
    std: 'Evítela en muestras probabilísticas (puede sesgar los resultados); prefiera liberar reservas. Si la usa, solo ante no contacto o rechazo definitivos.',
  },
  rule: {
    text: 'Qué reserva reemplaza a la unidad: una del mismo estrato o la siguiente reserva en orden.',
    std: 'El mismo estrato mantiene el equilibrio del diseño.',
  },
  reasons: {
    text: 'Los resultados finales que permiten un sustituto.',
    std: 'Rechazo y no contacto tras el número previsto de visitas o llamadas; nunca la no elegibilidad.',
  },
};
