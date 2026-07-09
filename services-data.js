// services-data.js — pricing & locations. Edit here to add service packages, change prices, or add surf spots — no other file needs to change.

window.SERVICES_DATA = {
  // Base price is per person for a 2-hour session; rental is per person per day.
  sessionPricing: {
    surf: { base: 80,  rental: 20 },
    kite: { base: 140, rental: 45 },
    wing: { base: 160, rental: 40 },
    sup:  { base: 70,  rental: 15 }
  },
  // Flat add-on fees (not scaled by headcount)
  addonPricing: {
    photoVideo: 200,
    drone: 200
  },
  // Pick-up areas for transfers, with rough [lat, lon] — used to estimate transfer price vs. a destination spot
  transferOrigins: {
    'Canggu': [-8.6478, 115.1385], 'Seminyak': [-8.6905, 115.1568], 'Kuta': [-8.7215, 115.1686],
    'Jimbaran': [-8.7909, 115.1573], 'Uluwatu': [-8.8291, 115.0849], 'Ubud': [-8.5069, 115.2625],
    'Sanur': [-8.6870, 115.2626], 'Nusa Dua': [-8.7961, 115.2280], 'Airport (DPS)': [-8.7467, 115.1670]
  },
  // [lat, lon] for each named surf spot (used for the same transfer-distance estimate)
  spotCoords: {
    'Kuta Beach': [-8.717, 115.168], 'Batu Bolong': [-8.657, 115.128], 'Seminyak Beach': [-8.690, 115.157],
    'Kuta Reef': [-8.735, 115.160], 'Balangan': [-8.792, 115.122], 'Berawa': [-8.668, 115.135],
    'Medewi': [-8.435, 114.803], 'Uluwatu': [-8.815, 115.088], 'Padang Padang': [-8.808, 115.103],
    'Keramas': [-8.596, 115.331], 'Sanur Lagoon': [-8.703, 115.262], 'Nusa Lembongan': [-8.681, 115.447],
    'Sanur Reef': [-8.712, 115.268], 'Tanjung Benoa': [-8.760, 115.222], 'Mushroom Bay': [-8.681, 115.446]
  },
  // Spot pools per discipline. Surf is further split by level (0=first timer .. 3=advanced) since
  // beginner-friendly breaks differ from advanced reef breaks. Each entry: { lat, lon, shore, name, region }.
  spots: {
    surf: {
      0: [
        { lat:-8.717, lon:115.168, shore:245, name:'Kuta Beach',     region:'Kuta' },
        { lat:-8.657, lon:115.128, shore:250, name:'Batu Bolong',    region:'Canggu' },
        { lat:-8.690, lon:115.157, shore:250, name:'Seminyak Beach', region:'Seminyak' }
      ],
      1: [
        { lat:-8.657, lon:115.128, shore:250, name:'Batu Bolong', region:'Canggu' },
        { lat:-8.735, lon:115.160, shore:245, name:'Kuta Reef',   region:'Kuta' },
        { lat:-8.792, lon:115.122, shore:235, name:'Balangan',    region:'Bukit' }
      ],
      2: [
        { lat:-8.792, lon:115.122, shore:235, name:'Balangan', region:'Bukit' },
        { lat:-8.668, lon:115.135, shore:250, name:'Berawa',   region:'Canggu' },
        { lat:-8.435, lon:114.803, shore:210, name:'Medewi',   region:'West Bali' }
      ],
      3: [
        { lat:-8.815, lon:115.088, shore:225, name:'Uluwatu',      region:'Bukit' },
        { lat:-8.808, lon:115.103, shore:225, name:'Padang Padang', region:'Bukit' },
        { lat:-8.596, lon:115.331, shore:110, name:'Keramas',      region:'East Bali' }
      ]
    },
    kite: [
      { lat:-8.703, lon:115.262, shore:95,  name:'Sanur Lagoon',    region:'Sanur' },
      { lat:-8.681, lon:115.447, shore:150, name:'Nusa Lembongan',  region:'Nusa' }
    ],
    wing: [
      { lat:-8.712, lon:115.268, shore:95,  name:'Sanur Reef',      region:'Sanur' },
      { lat:-8.681, lon:115.447, shore:150, name:'Nusa Lembongan',  region:'Nusa' }
    ],
    sup: [
      { lat:-8.703, lon:115.262, shore:95,  name:'Sanur Lagoon',    region:'Sanur' },
      { lat:-8.760, lon:115.222, shore:100, name:'Tanjung Benoa',   region:'Benoa' },
      { lat:-8.681, lon:115.446, shore:150, name:'Mushroom Bay',    region:'Nusa' }
    ]
  }
};
