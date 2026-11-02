// Newspaper-style "what just happened" stories for the full-table pop-up
// shown after every action. Pure presentation: it only reads an already
// resolved `lastAction` plus the snapshot's player list, and never touches
// match state. Variants are picked by `action.seq`, so every client renders
// the same wording for the same action without any extra network traffic.
//
// tone drives the pop-up's kicker colour:
//   good - a clear win for the actor     hot  - an aggressive move that landed
//   bad  - a failed attempt              dark - shady dealings

import { RANK_LABELS } from './player.js';
import { OPPORTUNITY_DEFINITIONS } from './politicalOpportunities.js';
import { formatMoney } from './utils.js';

const pick = (variants, seq) => variants[seq % variants.length];

function assetLabel(type) {
  const def = OPPORTUNITY_DEFINITIONS[type];
  return def ? `${def.icon} ${def.name}` : 'satu aset politik';
}

function projekStory(action, A, seq) {
  const card = action.card;
  const reward = card.reward || { money: card.money, influence: card.influence };
  const name = card.name;
  const money = formatMoney(reward.money);
  const bodies = [
    `Gunting emas berkilat, kamera berkelip, ucapan 40 minit. ${A} merasmikan ${name} — rakyat dapat gambar kenangan, ${A} dapat ${money} dan ${reward.influence} pengaruh.`,
    `Papan tanda gergasi tertulis "Dengan Penuh Dedikasi: ${A}". ${name} siap (kononnya), kontraktor tersenyum sampai ke bank, dan ${A} bertambah ${money}.`,
    `${A} berdiri di atas podium dan berjanji ${name} akan siap "tidak lama lagi". Tidak lama itu, kata orang, ialah tarikh yang belum wujud. Hasilnya: ${money} dan ${reward.influence} pengaruh.`,
  ];
  const extras = [];
  if (reward.sponsorBoosted) extras.push('🏦 Corporate Sponsor menambah 20% pada hasil duit.');
  if (card.scandal) extras.push(`Skandal ${A} naik ${card.scandal}% — ada yang mula bertanya siapa dapat kontrak.`);
  return {
    tone: 'good',
    kicker: 'Flash · Pembangunan',
    icon: '🏗️',
    headline: pick([`${A} potong pita ${name}`, `${name}: ${A} rasmikan`, `${A} turun padang, ${name} bermula`], seq),
    body: pick(bodies, seq),
    extra: extras.join(' '),
    meta: `+${money} · +${reward.influence} Pengaruh · Skandal +${card.scandal}%`,
  };
}

function mediaStory(action, A, T, seq) {
  const card = action.card;
  const base = { kicker: 'Flash · Kempen Imej', meta: `Kos ${formatMoney(card.cost)}`, extra: '' };
  switch (card.id) {
    case 'sidang-media':
      return { ...base, tone: 'good', icon: '🎤', headline: `${A} buka sidang media`, body: `Dengan senyuman diplomatik dan tiga jawapan "tiada komen", ${A} memujuk para wartawan. Skandal reda 10%, dan perisai Sokongan Rakyat dipasang.` };
    case 'alih-perhatian':
      return { ...base, tone: 'hot', icon: '🎭', headline: `${A} alihkan perhatian ke ${T}`, body: `Tiba-tiba seluruh negara bercakap tentang ${T}. ${A} menghirup kopi dan tersenyum. Skandal ${T} naik 10%, skandal ${A} turun 10%.` };
    case 'kempen-digital':
      return { ...base, tone: 'good', icon: '📱', headline: `Kempen digital ${A} meletup`, body: `Seribu akaun tak dikenali tiba-tiba memuji ${A}. Algoritma terpukau, netizen keliru. Skandal turun 20%.` };
    case 'program-rakyat':
      return { ...base, tone: 'good', icon: '🍛', headline: `${A} turun padang: Program Rakyat`, body: `${A} makan nasi lemak di warung tepi jalan dan ber-selfie dengan pakcik berbasikal. Pengaruh +100, skandal turun 10%.` };
    case 'temu-bual':
      return action.success
        ? { ...base, tone: 'good', icon: '📺', headline: `Temu bual ${A} cuti akhbar`, body: `Satu soalan sukar, satu jawapan licin. Pengacara tergamam, penonton bertepuk. Skandal ${A} turun 40%.` }
        : { ...base, tone: 'bad', icon: '🎙️', headline: `Temu bual ${A} jadi bencana`, body: `Mikrofon masih hidup ketika ${A} berkata sesuatu yang tak patut. Klip tular dalam lima minit. Skandal naik 20%.` };
    case 'iklan-tv':
      return { ...base, tone: 'good', icon: '🇲🇾', headline: `Iklan TV ${A} di waktu perdana`, body: `Muzik sayu, bendera berkibar, kanak-kanak tersenyum. ${A} kini dilindungi perisai Sokongan Rakyat selama beberapa giliran.` };
    default:
      return { ...base, tone: 'good', icon: '📣', headline: `${A} guna ${card.name}`, body: `${A} melancarkan kempen imej "${card.name}" dan berharap rakyat lupa semua yang lalu.` };
  }
}

function politikStory(action, A, seq) {
  const rank = RANK_LABELS[action.toRank];
  const meta = `Peluang ${Math.round(action.chance * 100)}% · Kos ${action.cost} Pengaruh`;
  const extra = action.partyMachinery ? '⚙️ Party Machinery menolak dari belakang (+10% peluang).' : '';
  if (action.success) {
    return {
      tone: 'good', kicker: 'Flash · Politik', icon: '🎖️', extra, meta,
      headline: pick([`${A} naik pangkat: ${rank}`, `${A} dilantik ${rank}`, `Kerusi ${rank} dapat tuan baru: ${A}`], seq),
      body: pick([
        `Kerusi ${rank} itu kosong terlalu lama. ${A} duduk dulu sebelum sesiapa sempat berkata "tunggu".`,
        `Majlis angkat sumpah dibuat tergesa-gesa. ${A} kini ${rank} — dan sudah mula mencari pejabat yang lebih besar.`,
        `Telefon berdering sepanjang malam; esoknya ${A} bangun sebagai ${rank}. Ada yang kata bakat, ada yang kata "kenal siapa".`,
      ], seq),
    };
  }
  return {
    tone: 'bad', kicker: 'Flash · Politik', icon: '📉', extra, meta,
    headline: pick([`${A} gagal naik ke ${rank}`, `Cubaan ${A} ke ${rank} tersungkur`, `${rank}: ${A} belum cukup sokongan`], seq),
    body: pick([
      `Ahli parti memilih "tak hadir" ramai-ramai. ${A} pulang membawa pengaruh yang sudah hangus dan senyuman yang sudah beku.`,
      `Undi tertutup, keputusan terbuka: ${A} tidak cukup. Kerusi ${rank} terus menunggu orang lain.`,
      `${A} sudah tempah kek tahniah. Kek itu kini dimakan orang lain.`,
    ], seq),
  };
}

function sabotajStory(action, A, T, target, seq) {
  const meta = `${action.isKabel ? 'KABEL · ' : ''}Peluang ${Math.round(action.chance * 100)}% · Kos ${action.cost} Pengaruh`;
  const rank = RANK_LABELS[action.toRank];
  const royal = action.targetRoyal ? ` 👑 Royal Connection ${T} menyukarkan serangan ini.` : '';
  if (action.isKabel) {
    return action.success
      ? {
        tone: 'hot', kicker: 'Flash · KABEL', icon: '🕴️', extra: royal.trim(), meta,
        headline: `KABEL! ${A} melangkau ke ${rank}`,
        body: `Satu panggilan dari "orang atas", satu sampul tanpa nama — dan ${A} tiba-tiba menduduki kerusi ${rank} milik ${T}. ${T} tak sempat habiskan kopinya.`,
      }
      : {
        tone: 'bad', kicker: 'Flash · KABEL', icon: '📞', extra: royal.trim(), meta,
        headline: `KABEL ${A} terputus`,
        body: `Talian "orang atas" tiba-tiba senyap. ${A} cuba merampas kerusi ${T}, tetapi sampul itu dihantar ke alamat yang salah.`,
      };
  }
  if (action.success) {
    return {
      tone: 'hot', kicker: 'Flash · Sabotaj', icon: '🪑', extra: royal.trim(), meta,
      headline: pick([`${A} telah curi kerusi ${T}!`, `Kerusi ${T} bertukar tangan: ${A} menang`, `${T} tersingkir, ${A} naik ke ${rank}`], seq),
      body: pick([
        `Dokumen bocor, wartawan menunggu di lobi — dan kerusi ${rank} milik ${T} kini ada nama baru: ${A}. ${T} diturunkan ke ${RANK_LABELS[target?.rank] || 'bawah'}.`,
        `Satu pintu diketuk tengah malam, satu sampul diserahkan. Pagi esoknya ${T} sudah menjadi bekas ${rank}, dan ${A} bersiul sambil duduk di kerusi baru.`,
        `"Ini bukan peribadi," kata ${A} sambil mengambil kerusi ${T}. Memang bukan — ini strategi.`,
      ], seq),
    };
  }
  return {
    tone: 'bad', kicker: 'Flash · Sabotaj', icon: '💣', extra: royal.trim(), meta,
    headline: pick([`${A} gagal gulingkan ${T}`, `Rancangan ${A} terdedah`, `${T} masih duduk, ${A} menanggung malu`], seq),
    body: pick([
      `Rancangan ${A} bocor sebelum sempat dijalankan. ${T} duduk tenang di kerusinya, manakala ${A} dapat tajuk berita yang memalukan. Skandal ${A} naik 15%.`,
      `${A} menghantar orang untuk menjatuhkan ${T}. Orang itu pulang dengan sandwic percuma dan tangan kosong. Skandal ${A} naik 15%.`,
      `Fitnah ${A} tentang ${T} berbalik arah. Kini ${A} pula yang menjawab soalan wartawan. Skandal naik 15%.`,
    ], seq),
  };
}

function raidStory(action, A, T, seq) {
  const asset = assetLabel(action.assetType);
  const meta = `Peluang ${Math.round(action.chance * 100)}% · Kos ${action.cost} Pengaruh`;
  if (action.success) {
    return {
      tone: 'hot', kicker: 'Flash · Rampasan Aset', icon: '🦹', extra: '', meta,
      headline: pick([`${A} rampas ${asset} daripada ${T}`, `${T} kehilangan ${asset}!`, `${asset} bertukar tuan: ${A}`], seq),
      body: pick([
        `Pagi tadi ${T} masih memiliki ${asset}. Petang ini ${A} yang menandatangani serah terima — tanpa notis, tanpa kek.`,
        `Pasukan ${A} masuk ikut pintu belakang. Bila lampu dinyalakan, ${asset} sudah bertukar tangan dan ${T} masih mencari kunci.`,
        `Peguam ${A} tiba dengan seratus helai dokumen. ${T} menandatangani helaian ke-99 tanpa membaca. ${asset} kini milik ${A}.`,
      ], seq),
    };
  }
  return {
    tone: 'bad', kicker: 'Flash · Rampasan Aset', icon: '🚨', extra: '', meta,
    headline: pick([`Rampasan ${A} gagal`, `${A} tersekat di pintu ${T}`, `${asset} selamat daripada ${A}`], seq),
    body: pick([
      `${A} cuba memecah masuk ke pejabat ${T}, tetapi penggera berbunyi dan ${asset} kekal selamat. Pengaruh ${A} hangus begitu sahaja.`,
      `Pengawal ${T} ternyata lebih berjaga daripada yang dijangka. ${A} pulang tanpa ${asset} dan tanpa alasan yang meyakinkan.`,
    ], seq),
  };
}

function marketStory(action, A, seq) {
  const asset = assetLabel(action.assetType);
  const scandal = action.scandalGain ? `Skandal ${A} melonjak ${action.scandalGain}%.` : '';
  return {
    tone: 'dark', kicker: 'Flash · Pasar Gelap', icon: '💼', extra: scandal, meta: `Harga ${formatMoney(action.price)}`,
    headline: pick([`${A} beli ${asset} di pasar gelap`, `Beg hitam ${A}: ${asset}`, `${asset} muncul di tangan ${A}`], seq),
    body: pick([
      `Di lorong belakang pukul 3 pagi, sebuah beg hitam bertukar tangan. ${A} keluar membawa ${asset} — dan dompet yang jauh lebih nipis.`,
      `Tiada resit, tiada saksi, hanya sekeping nota: "${asset}, ${formatMoney(action.price)}, tunai." ${A} mengangguk dan berlalu.`,
    ], seq),
  };
}

function skipStory(A) {
  return {
    tone: 'bad', kicker: 'Flash · Giliran', icon: '⏭️', extra: '', meta: '',
    headline: `Giliran ${A} dilangkau`,
    body: `Hos mengetuk meja: masa tamat. Giliran ${A} dilangkau dan permainan diteruskan.`,
  };
}

function penaltyLines(snapshot) {
  return (snapshot.lastPenalized || [])
    .map((id) => snapshot.players.find((p) => p.id === id))
    .filter(Boolean)
    .map((p) => `⚠️ ${p.name} mencecah 100% skandal — SPRM mengetuk pintu: hilang 50% duit dan turun satu pangkat.`);
}

// Returns null for actions that already announce themselves another way (a
// leaked Backroom Deal gets its own BREAKING NEWS overlay).
export function buildActionStory(action, snapshot) {
  if (!action) return null;
  const nameOf = (id, fallback) => snapshot.players.find((p) => p.id === id)?.name || fallback;
  const A = nameOf(action.actorId, 'Seseorang');
  const T = nameOf(action.targetId, 'pemain lain');
  const target = snapshot.players.find((p) => p.id === action.targetId);
  const seq = action.seq || 0;

  let story = null;
  if (action.type === 'projek') story = projekStory(action, A, seq);
  else if (action.type === 'media') story = mediaStory(action, A, T, seq);
  else if (action.type === 'politik') story = politikStory(action, A, seq);
  else if (action.type === 'sabotaj') story = sabotajStory(action, A, T, target, seq);
  else if (action.type === 'raid') story = raidStory(action, A, T, seq);
  else if (action.type === 'market') story = marketStory(action, A, seq);
  else if (action.type === 'skip' && action.reason !== 'bribery-leak') story = skipStory(A);
  if (!story) return null;

  const penalties = penaltyLines(snapshot);
  if (penalties.length) story.extra = [story.extra, ...penalties].filter(Boolean).join(' ');
  return story;
}
