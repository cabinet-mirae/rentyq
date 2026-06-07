// Cloudflare Pages Function — /api/events
// Combine Ticketmaster + OpenAgenda pour maximum de couverture
// v2 — recherche par grande ville la plus proche pour les petites communes
const TM_KEY = 'g6wYdNGGjHeWmX3eYxju5Z0bQIVT7nXc';
const TM_API = 'https://app.ticketmaster.com/discovery/v2/events.json';
const OA_API = 'https://public.opendatasoft.com/api/explore/v2.1/catalog/datasets/evenements-publics-openagenda/records';

// Mapping petites communes → grande ville la plus proche
const NEARBY_CITIES = {
  'saint-denis-en-val':'Orléans','saint-jean-de-braye':'Orléans','olivet':'Orléans','fleury-les-aubrais':'Orléans','saran':'Orléans','la chapelle-saint-mesmin':'Orléans','saint-jean-le-blanc':'Orléans','saint-pryvé-saint-mesmin':'Orléans','ingré':'Orléans','chécy':'Orléans','saint-jean-de-la-ruelle':'Orléans','semoy':'Orléans','la source':'Orléans',
  'villeurbanne':'Lyon','vénissieux':'Lyon','bron':'Lyon','caluire-et-cuire':'Lyon','vaulx-en-velin':'Lyon','saint-priest':'Lyon','oullins':'Lyon','décines-charpieu':'Lyon','ecully':'Lyon','tassin-la-demi-lune':'Lyon','rillieux-la-pape':'Lyon','meyzieu':'Lyon','saint-fons':'Lyon','francheville':'Lyon','pierre-bénite':'Lyon','sainte-foy-lès-lyon':'Lyon','irigny':'Lyon',
  'boulogne-billancourt':'Paris','saint-denis':'Paris','montreuil':'Paris','argenteuil':'Paris','nanterre':'Paris','créteil':'Paris','courbevoie':'Paris','versailles':'Paris','colombes':'Paris','asnières-sur-seine':'Paris','rueil-malmaison':'Paris','champigny-sur-marne':'Paris','aubervilliers':'Paris','vitry-sur-seine':'Paris','aulnay-sous-bois':'Paris','drancy':'Paris','noisy-le-grand':'Paris','levallois-perret':'Paris','issy-les-moulineaux':'Paris','ivry-sur-seine':'Paris','cergy':'Paris','pantin':'Paris','bondy':'Paris','fontenay-sous-bois':'Paris','clamart':'Paris','sartrouville':'Paris','antony':'Paris','maisons-alfort':'Paris','épinay-sur-seine':'Paris','sevran':'Paris','meudon':'Paris','rosny-sous-bois':'Paris',
  'mérignac':'Bordeaux','pessac':'Bordeaux','talence':'Bordeaux','villenave-d\'ornon':'Bordeaux','bègles':'Bordeaux','gradignan':'Bordeaux','le bouscat':'Bordeaux','cenon':'Bordeaux','floirac':'Bordeaux','lormont':'Bordeaux','blanquefort':'Bordeaux','eysines':'Bordeaux','bruges':'Bordeaux',
  'colomiers':'Toulouse','tournefeuille':'Toulouse','blagnac':'Toulouse','muret':'Toulouse','ramonville-saint-agne':'Toulouse','balma':'Toulouse','cugnaux':'Toulouse','l\'union':'Toulouse','castanet-tolosan':'Toulouse','plaisance-du-touch':'Toulouse',
  'aix-en-provence':'Marseille','aubagne':'Marseille','martigues':'Marseille','salon-de-provence':'Marseille','istres':'Marseille','la ciotat':'Marseille','vitrolles':'Marseille','marignane':'Marseille',
  'saint-herblain':'Nantes','rezé':'Nantes','orvault':'Nantes','vertou':'Nantes','couëron':'Nantes','carquefou':'Nantes','bouguenais':'Nantes','saint-sébastien-sur-loire':'Nantes',
  'roubaix':'Lille','tourcoing':'Lille','villeneuve-d\'ascq':'Lille','wattrelos':'Lille','marcq-en-barœul':'Lille','lambersart':'Lille','hem':'Lille','wasquehal':'Lille','croix':'Lille','mons-en-barœul':'Lille',
  'saint-martin-d\'hères':'Grenoble','échirolles':'Grenoble','fontaine':'Grenoble','meylan':'Grenoble','seyssinet-pariset':'Grenoble','eybens':'Grenoble',
  'le mans':'Le Mans','allonnes':'Le Mans','coulaines':'Le Mans',
  'sotteville-lès-rouen':'Rouen','le petit-quevilly':'Rouen','le grand-quevilly':'Rouen','mont-saint-aignan':'Rouen','bois-guillaume':'Rouen',
  'hérouville-saint-clair':'Caen','mondeville':'Caen','ifs':'Caen','colombelles':'Caen',
  'schiltigheim':'Strasbourg','illkirch-graffenstaden':'Strasbourg','lingolsheim':'Strasbourg','bischheim':'Strasbourg','hoenheim':'Strasbourg',
  'castelnau-le-lez':'Montpellier','lattes':'Montpellier','juvignac':'Montpellier','saint-jean-de-védas':'Montpellier','pérols':'Montpellier',
  'saint-nazaire':'Nantes','la baule-escoublac':'Nantes',
  'cannes':'Nice','antibes':'Nice','grasse':'Nice','cagnes-sur-mer':'Nice','le cannet':'Nice','mougins':'Nice','vallauris':'Nice','vence':'Nice','menton':'Nice',
  'bayonne':'Biarritz','anglet':'Biarritz','saint-jean-de-luz':'Biarritz',
  'biarritz':'Biarritz','pau':'Pau','tarbes':'Tarbes','lourdes':'Tarbes',
  'chalon-sur-saône':'Dijon','beaune':'Dijon',
  'vichy':'Clermont-Ferrand','issoire':'Clermont-Ferrand','riom':'Clermont-Ferrand',
  'saint-étienne':'Saint-Étienne','firminy':'Saint-Étienne','saint-chamond':'Saint-Étienne',
  'tours':'Tours','blois':'Tours','amboise':'Tours','chinon':'Tours',
  'angers':'Angers','cholet':'Angers','saumur':'Angers',
  'la rochelle':'La Rochelle','rochefort':'La Rochelle',
  'limoges':'Limoges','brive-la-gaillarde':'Limoges',
  'poitiers':'Poitiers','châtellerault':'Poitiers','niort':'Poitiers',
  'reims':'Reims','épernay':'Reims','châlons-en-champagne':'Reims',
  'metz':'Metz','thionville':'Metz',
  'nancy':'Nancy','lunéville':'Nancy','toul':'Nancy',
  'besançon':'Besançon','montbéliard':'Besançon','belfort':'Besançon',
  'amiens':'Amiens','abbeville':'Amiens',
  'orléans':'Orléans','chartres':'Orléans','dreux':'Orléans','montargis':'Orléans','pithiviers':'Orléans','beaugency':'Orléans','meung-sur-loire':'Orléans','jargeau':'Orléans',
};

function resolveCity(city) {
  if (!city) return { searchCity: city, originalCity: city };
  const normalized = city.toLowerCase().trim();
  const mapped = NEARBY_CITIES[normalized];
  return {
    searchCity: mapped || city,
    originalCity: city,
    isMapped: !!mapped
  };
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
  });
}

export async function onRequestPost(context) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  try {
    const { city, countryCode, radius } = await context.request.json();
    if (!city) {
      return new Response(JSON.stringify({ error: 'Ville manquante' }), { status: 400, headers });
    }

    const resolved = resolveCity(city);
    const searchRadius = resolved.isMapped ? Math.max(radius || 50, 50) : (radius || 50);

    // Fetch both APIs in parallel — search by nearest big city
    const [tmEvents, oaEvents] = await Promise.all([
      fetchTicketmaster(resolved.searchCity, countryCode, searchRadius),
      fetchOpenAgenda(resolved.searchCity)
    ]);

    // If mapped city, also try original city for local events
    let localEvents = [];
    if (resolved.isMapped) {
      const [tmLocal, oaLocal] = await Promise.all([
        fetchTicketmaster(resolved.originalCity, countryCode, 20),
        fetchOpenAgenda(resolved.originalCity)
      ]);
      localEvents = [...tmLocal, ...oaLocal];
    }

    // Merge and deduplicate
    const all = [...localEvents, ...tmEvents, ...oaEvents];
    const seen = new Set();
    const unique = all.filter(e => {
      const key = e.name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by date
    unique.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    return new Response(JSON.stringify(unique), { headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Erreur serveur: ' + err.message }), { status: 500, headers });
  }
}

async function fetchTicketmaster(city, countryCode, radius) {
  try {
    const now = new Date();
    const end = new Date(Date.now() + 180 * 86400000);
    const fmt = d => d.toISOString().split('.')[0] + 'Z';

    const params = new URLSearchParams({
      apikey: TM_KEY,
      city: city,
      countryCode: countryCode || 'FR',
      radius: String(radius || 50),
      unit: 'km',
      size: '50',
      sort: 'date,asc',
      startDateTime: fmt(now),
      endDateTime: fmt(end)
    });

    const res = await fetch(`${TM_API}?${params}`);
    const data = await res.json();

    return (data._embedded?.events || []).map(e => ({
      name: e.name,
      date: e.dates?.start?.localDate,
      time: e.dates?.start?.localTime,
      venue: e._embedded?.venues?.[0]?.name,
      city: e._embedded?.venues?.[0]?.city?.name || city,
      segment: e.classifications?.[0]?.segment?.name,
      genre: e.classifications?.[0]?.genre?.name,
      url: e.url,
      image: e.images?.[0]?.url,
      source: 'ticketmaster'
    }));
  } catch (e) {
    return [];
  }
}

async function fetchOpenAgenda(city) {
  try {
    const now = new Date().toISOString().split('T')[0];

    const params = new URLSearchParams({
      limit: '50',
      'refine': `location_city:${city}`,
      'where': `firstdate_begin >= "${now}"`,
      'order_by': 'firstdate_begin ASC'
    });

    const res = await fetch(`${OA_API}?${params}`);
    const data = await res.json();

    return (data.results || []).map(r => {
      const title = r.title_fr || r.title || r.description_fr || '';
      const dateStr = r.firstdate_begin || '';
      const date = dateStr ? dateStr.split('T')[0] : '';
      const keywords = (Array.isArray(r.keywords_fr) ? r.keywords_fr.join(' ') : r.keywords_fr) || '';

      let segment = 'Misc';
      let genre = '';
      const kw = (keywords + ' ' + title).toLowerCase();
      if (kw.includes('concert') || kw.includes('musique') || kw.includes('festival') || kw.includes('jazz') || kw.includes('rock')) {
        segment = 'Music'; genre = 'Concert';
      } else if (kw.includes('sport') || kw.includes('marathon') || kw.includes('foot') || kw.includes('rugby') || kw.includes('course') || kw.includes('athl')) {
        segment = 'Sports'; genre = 'Sport';
      } else if (kw.includes('salon') || kw.includes('foire') || kw.includes('exposition') || kw.includes('marché') || kw.includes('brocante')) {
        segment = 'Arts'; genre = 'Salon/Foire';
      } else if (kw.includes('théâtre') || kw.includes('spectacle') || kw.includes('comédie') || kw.includes('danse') || kw.includes('cirque')) {
        segment = 'Arts'; genre = 'Spectacle';
      } else if (kw.includes('conférence') || kw.includes('congrès') || kw.includes('colloque') || kw.includes('séminaire') || kw.includes('forum')) {
        segment = 'Conference'; genre = 'Conférence';
      } else if (kw.includes('noël') || kw.includes('fête') || kw.includes('carnaval') || kw.includes('14 juillet') || kw.includes('patrimoine')) {
        segment = 'Festival'; genre = 'Fête locale';
      }

      return {
        name: title.length > 80 ? title.slice(0, 77) + '...' : title,
        date: date,
        time: null,
        venue: r.location_name || '',
        city: r.location_city || city,
        segment: segment,
        genre: genre,
        url: r.canonicalurl || '',
        image: r.image || null,
        source: 'openagenda'
      };
    }).filter(e => e.name && e.date);
  } catch (e) {
    return [];
  }
}
