/* =========================================================
   YAWAR INKA — Control de vestimentas, danzas y alquileres
   Persistencia híbrida (Local + Sincronización en tiempo real con Firebase Firestore).
   Compatible con Visual Studio Code (Live Server), GitHub Pages y doble clic local.
   ========================================================= */

// Variables globales para la sincronización de base de datos
let db = null;
let isFirebaseAvailable = false;
let isRemoteUpdate = false;

const STORAGE_KEY = 'yawar_inka_inventario_v3';
const LEGACY_KEYS = [
  'yawar_inka_inventario_v2',
  'yawar_inka_inventario_v1',
  'chiwirincas_inventario_v1',
  'kipu_inventario_v1'
];

const SIZE_PRESETS = ['4', '6', '8', '10', '12', '14', '16', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

const ICON_GARMENT = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 4L12 2L15 4C15 4 15.5 5.3 17 5.6L21 8.5L18.5 11.3L17 10V21H7V10L5.5 11.3L3 8.5L7 5.6C8.5 5.3 9 4 9 4Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
const ICON_DANCE = '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="5.2" r="2.2" stroke="currentColor" stroke-width="1.6"/><path d="M12 8V14M12 14L7.5 21M12 14L16.5 21M8 11L12 14L16 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let state = loadState();

/* ========================= CONTROL DE ACCESO Y MODO CATÁLOGO ========================= */

const AUTHORIZED_ADMIN_EMAILS = [
  'jhonbastidas2805@gmail.com',
  'bastidasjhon033@gmail.com'
];
const DEFAULT_ADMIN_EMAIL = 'jhonbastidas2805@gmail.com';
const ADMIN_PINS = ['2805', '1234'];
const AUTH_STORAGE_KEY = 'yawar_inka_admin_email';
const WHATSAPP_PHONE = '51917607753';

// Verificar si se ingresó mediante enlace público de catálogo (?modo=catalogo)
const urlParams = new URLSearchParams(window.location.search);
const hasCatalogParam = urlParams.get('modo') === 'catalogo' || urlParams.get('vista') === 'catalogo' || urlParams.get('catalogo') === '1';

// Estado de autenticación - Solo es admin si se autenticó previamente con correo autorizado
let currentAdminEmail = localStorage.getItem(AUTH_STORAGE_KEY);

let isAdmin = Boolean(
  currentAdminEmail && 
  AUTHORIZED_ADMIN_EMAILS.includes(currentAdminEmail.toLowerCase().trim())
);

// Por defecto, cualquier visitante o nuevo dispositivo entra en modo catálogo público protegido
let isCatalogMode = !isAdmin || hasCatalogParam;

// Estado temporal modal Producto
let editingProductId = null;
let editingProductHasSizes = true;
let editingSizes = {}; // { "6": 4, "10": 5, "XL": 4 }
let editingProductPhoto = null;

// Estado temporal modal Danza
let editingDanceId = null;
let editingRequirements = []; // [productId, ...]
let editingDancePhoto = null;

// Estado temporal modal Alquiler
let editingRentalId = null;
let editingRentalMenSizes = {}; // { '6': 4, '16': 8, 'S': 2 }
let editingRentalWomenSizes = {}; // { '8': 5, '14': 6, 'S': 1 }
let editingRentalStudents = []; // [ { id, name, gender: 'male'|'female', size: '16' } ]
let editingRentalCustomMaleSizes = [];
let editingRentalCustomFemaleSizes = [];
let editingRentalItems = [];
let currentRentalFilter = 'all';

// Cámara en vivo
let currentCameraStream = null;
let onPhotoCapturedCallback = null;

/* ========================= PERSISTENCIA ========================= */

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadState() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      for (const k of LEGACY_KEYS) {
        raw = localStorage.getItem(k);
        if (raw) break;
      }
    }
    if (raw) {
      const data = JSON.parse(raw);
      if (!Array.isArray(data.products)) data.products = [];
      if (!Array.isArray(data.dances)) data.dances = [];
      if (!Array.isArray(data.rentals)) data.rentals = [];

      data.products.forEach((p) => {
        if (p.hasSizes === undefined) {
          p.hasSizes = p.sizes && Object.keys(p.sizes).length > 0;
        }
        if (p.totalDirectQty === undefined) {
          p.totalDirectQty = p.hasSizes ? 0 : 10;
        }
      });

      data.dances.forEach((d) => {
        if (Array.isArray(d.requirements)) {
          d.requirements = d.requirements.map((r) => (typeof r === 'object' && r.productId ? r.productId : r));
          d.requirements = [...new Set(d.requirements)];
        }
      });

      data.rentals.forEach((r) => {
        if (!r.status) r.status = 'active';
        if (!Array.isArray(r.items)) r.items = [];
      });

      return data;
    }
  } catch (e) {
    console.error('Error al cargar datos locales', e);
  }
  return { products: [], dances: [], rentals: [] };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  pushFullStateToFirestore(state);
}

function sizeSortValue(label) {
  const idx = SIZE_PRESETS.indexOf(label);
  return idx === -1 ? 999 + String(label).charCodeAt(0) : idx;
}

function sortedSizeEntries(sizesObj) {
  return Object.entries(sizesObj || {}).sort((a, b) => sizeSortValue(a[0]) - sizeSortValue(b[0]));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 2200);
}

function dancesUsingProduct(productId) {
  return state.dances
    .filter((d) => (d.requirements || []).includes(productId))
    .map((d) => d.name);
}

/* ========================= CÁLCULO DE STOCK Y DISPONIBILIDAD ========================= */

// Devuelve un mapa con el stock alquilado activo por producto y por talla
function getRentedStockMap() {
  const rented = {}; // { [productId]: { total: number, sizes: { [size]: number }, directQty: number } }

  state.rentals
    .filter((r) => r.status === 'active')
    .forEach((rental) => {
      let items = rental.items || [];
      // Si no tiene items explícitos pero tiene danza registrada y tallas de varones/mujeres
      if (items.length === 0 && rental.danceId) {
        const dance = state.dances.find((d) => d.id === rental.danceId);
        if (dance && Array.isArray(dance.requirements)) {
          const combinedSizes = {};
          Object.entries(rental.menSizes || {}).forEach(([sz, q]) => {
            combinedSizes[sz] = (combinedSizes[sz] || 0) + Number(q || 0);
          });
          Object.entries(rental.womenSizes || {}).forEach(([sz, q]) => {
            combinedSizes[sz] = (combinedSizes[sz] || 0) + Number(q || 0);
          });
          const totalQty = Object.values(combinedSizes).reduce((a, b) => a + b, 0);

          items = dance.requirements.map((prodId) => {
            const prod = state.products.find((p) => p.id === prodId);
            if (prod && prod.hasSizes === false) {
              return { productId: prodId, sizes: {}, directQty: totalQty };
            }
            return { productId: prodId, sizes: combinedSizes, directQty: 0 };
          });
        }
      }

      items.forEach((item) => {
        if (!rented[item.productId]) {
          rented[item.productId] = { total: 0, sizes: {}, directQty: 0 };
        }
        if (item.sizes) {
          Object.entries(item.sizes).forEach(([size, qty]) => {
            const q = Number(qty || 0);
            rented[item.productId].sizes[size] = (rented[item.productId].sizes[size] || 0) + q;
            rented[item.productId].total += q;
          });
        }
        if (item.directQty) {
          const q = Number(item.directQty || 0);
          rented[item.productId].directQty += q;
          rented[item.productId].total += q;
        }
      });
    });

  return rented;
}

function getAvailableStockForProduct(productId) {
  const product = state.products.find((p) => p.id === productId);
  if (!product) return null;

  const rentedMap = getRentedStockMap();
  const rented = rentedMap[productId] || { total: 0, sizes: {}, directQty: 0 };

  if (product.hasSizes === false) {
    const total = Number(product.totalDirectQty || 0);
    const rentedQty = rented.directQty || 0;
    const available = Math.max(0, total - rentedQty);
    return {
      hasSizes: false,
      total,
      rented: rentedQty,
      available
    };
  } else {
    let total = 0;
    let totalRented = 0;
    const sizes = {};

    Object.entries(product.sizes || {}).forEach(([size, qty]) => {
      const q = Number(qty || 0);
      const r = Number(rented.sizes[size] || 0);
      const avail = Math.max(0, q - r);
      total += q;
      totalRented += r;
      sizes[size] = {
        total: q,
        rented: r,
        available: avail
      };
    });

    return {
      hasSizes: true,
      total,
      rented: totalRented,
      available: Math.max(0, total - totalRented),
      sizes
    };
  }
}

/* ========================= PESTAÑAS Y MODOS ========================= */

function switchView(viewName) {
  document.querySelectorAll('.tab').forEach((t) => {
    const isTarget = t.dataset.view === viewName;
    t.classList.toggle('active', isTarget);
    t.setAttribute('aria-selected', isTarget ? 'true' : 'false');
  });

  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  const targetView = document.getElementById('view-' + viewName);
  if (targetView) targetView.classList.add('active');

  if (viewName === 'alquileres') {
    renderRentals();
    renderAvailabilityPanel();
  } else if (viewName === 'danzas') {
    renderDances();
  } else if (viewName === 'inventario') {
    renderProducts();
  }
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    switchView(tab.dataset.view);
  });
});

function updateAuthUI() {
  const authContainer = document.getElementById('auth-status-container');
  const tabInventario = document.getElementById('tab-inventario');
  const tabAlquileres = document.getElementById('tab-alquileres');
  const tabDanzas = document.getElementById('tab-danzas');
  const btnAddDance = document.getElementById('btn-add-dance');
  const danzasTitle = document.getElementById('danzas-title');
  const danzasSubtitle = document.getElementById('danzas-subtitle');
  const footerActions = document.getElementById('footer-admin-actions');
  const footerAdminLink = document.getElementById('footer-admin-link');
  const brandSub = document.getElementById('brand-subtitle');

  if (!isAdmin || isCatalogMode) {
    // Modo Catálogo / No admin
    if (authContainer) {
      authContainer.innerHTML = `
        <button type="button" class="auth-badge-catalog" id="btn-open-auth-modal" title="Acceso para el administrador de YAWAR INKA">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          <span>Catálogo de Danzas</span>
        </button>
      `;
    }

    if (tabInventario) tabInventario.classList.add('hidden');
    if (tabAlquileres) tabAlquileres.classList.add('hidden');
    if (tabDanzas) tabDanzas.classList.remove('hidden');
    if (btnAddDance) btnAddDance.classList.add('hidden');
    if (footerActions) footerActions.classList.add('hidden');
    if (footerAdminLink) footerAdminLink.textContent = 'Acceso Administrador';

    if (danzasTitle) danzasTitle.textContent = 'Catálogo de Danzas';
    if (danzasSubtitle) danzasSubtitle.textContent = 'Consulta los trajes folclóricos y las piezas que lleva cada vestimenta.';
    if (brandSub) brandSub.textContent = 'Catálogo de vestimentas y danzas típicas';

    // Asegurar que estamos en la vista de danzas
    switchView('danzas');
  } else {
    // Modo Administrador
    if (authContainer) {
      const emailShort = (currentAdminEmail || DEFAULT_ADMIN_EMAIL).split('@')[0];
      authContainer.innerHTML = `
        <button type="button" class="auth-badge-admin" id="btn-open-auth-modal" title="Sesión de administrador activa (${escapeHtml(currentAdminEmail)})">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          <span>Admin (${escapeHtml(emailShort)})</span>
        </button>
      `;
    }

    if (tabInventario) tabInventario.classList.remove('hidden');
    if (tabAlquileres) tabAlquileres.classList.remove('hidden');
    if (tabDanzas) tabDanzas.classList.remove('hidden');
    if (btnAddDance) btnAddDance.classList.remove('hidden');
    if (footerActions) footerActions.classList.remove('hidden');
    if (footerAdminLink) footerAdminLink.textContent = 'Sesión Admin Activa';

    if (danzasTitle) danzasTitle.textContent = 'Vestuario por danza';
    if (danzasSubtitle) danzasSubtitle.textContent = 'Consulta y organización de las prendas que componen el traje de cada danza.';
    if (brandSub) brandSub.textContent = 'Control de vestimentas, danzas y alquileres';
  }

  // Re-vincular listener del botón en la barra superior
  const openAuthBtn = document.getElementById('btn-open-auth-modal');
  if (openAuthBtn) {
    openAuthBtn.addEventListener('click', openAdminAuthModal);
  }
}

/* ========================= RENDER: PRODUCTOS (ALMACÉN FÍSICO) ========================= */

function updateProductDanceFilterOptions() {
  const select = document.getElementById('filter-product-dance');
  if (!select) return;
  const currentVal = select.value;
  
  // Extraer todas las danzas disponibles
  const danceNames = Array.from(new Set(state.dances.map((d) => d.name).filter(Boolean))).sort();
  
  select.innerHTML = '<option value="">Todas las danzas</option>';
  danceNames.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === currentVal) opt.selected = true;
    select.appendChild(opt);
  });
}

function renderProductsSummary(displayedCount) {
  const el = document.getElementById('summary-inventario');
  const totalProductos = state.products.length;
  let totalUnidades = 0;

  state.products.forEach((p) => {
    if (p.hasSizes === false) {
      totalUnidades += Number(p.totalDirectQty || 0);
    } else {
      Object.values(p.sizes || {}).forEach((q) => {
        totalUnidades += Number(q || 0);
      });
    }
  });

  const countToShow = displayedCount !== undefined ? displayedCount : totalProductos;
  const showingText = countToShow !== totalProductos
    ? `Mostrando <strong>${countToShow}</strong> de <strong>${totalProductos}</strong> prendas`
    : `<strong>${totalProductos}</strong> prendas registradas`;

  el.innerHTML = `
    <div class="summary-chip">${showingText}</div>
    <div class="summary-chip">Total en almacén: <strong>${totalUnidades}</strong> unidades</div>
  `;
}

function renderProducts() {
  updateProductDanceFilterOptions();

  const grid = document.getElementById('products-grid');
  const tableContainer = document.getElementById('products-table-container');
  const tableBody = document.getElementById('products-table-body');
  const empty = document.getElementById('products-empty');
  const searchInput = document.getElementById('search-productos');
  const danceFilterSelect = document.getElementById('filter-product-dance');

  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
  const filterDance = danceFilterSelect ? danceFilterSelect.value.trim().toLowerCase() : '';

  const list = state.products.filter((p) => {
    const dances = dancesUsingProduct(p.id);
    const tag = p.danceTag || '';

    // Filtro por Danza del dropdown
    if (filterDance) {
      const matchTag = tag.toLowerCase() === filterDance;
      const matchDance = dances.some((d) => d.toLowerCase() === filterDance);
      if (!matchTag && !matchDance) return false;
    }

    if (!query) return true;
    const nameMatch = p.name && p.name.toLowerCase().includes(query);
    const tagMatch = tag && tag.toLowerCase().includes(query);
    const danceMatch = dances.some((d) => d.toLowerCase().includes(query));
    const sizesMatch = Object.keys(p.sizes || {}).some(
      (sz) => sz.toLowerCase() === query || sz.toLowerCase().includes(query) || `talla ${sz.toLowerCase()}`.includes(query)
    );
    return nameMatch || tagMatch || danceMatch || sizesMatch;
  });

  renderProductsSummary(list.length);

  grid.innerHTML = '';
  const hasNoProducts = state.products.length === 0;
  empty.classList.toggle('hidden', !hasNoProducts && list.length > 0);

  if (state.products.length !== 0 && list.length === 0) {
    grid.innerHTML = `<p class="empty-state" style="grid-column:1/-1">No se encontraron prendas que coincidan con la búsqueda o filtro.</p>`;
    return;
  }

  list.forEach((product) => {
    let middleContentHtml = '';

    if (product.hasSizes === false) {
      const total = Number(product.totalDirectQty || 0);
      middleContentHtml = `
        <div class="total-count-row">
          <span>Total en almacén</span>
          <span class="total-count-val">${total} und.</span>
        </div>
      `;
    } else {
      const sizeEntries = sortedSizeEntries(product.sizes);
      let total = 0;
      sizeEntries.forEach(([, q]) => (total += Number(q || 0)));

      const sizesHtml = sizeEntries.length
        ? sizeEntries.map(([label, qty]) => `
            <div class="size-item" title="Talla ${escapeHtml(label)}: ${qty} unidad(es)">
              <span class="size-item-lbl">Talla ${escapeHtml(label)}</span>
              <span class="size-item-qty">${qty}</span>
            </div>
          `).join('')
        : `<p style="color:var(--ink-faint); font-size:12.5px; margin:0; grid-column:1/-1;">Sin tallas registradas</p>`;

      middleContentHtml = `
        <div class="sizes-row">${sizesHtml}</div>
        <div class="total-count-row">
          <span>Total en almacén</span>
          <span class="total-count-val">${total} und.</span>
        </div>
      `;
    }

    const dancesList = dancesUsingProduct(product.id);
    let usedInHtml = '';
    if (product.danceTag) {
      usedInHtml = `<div class="used-in"><span>Danza:</span> <span class="used-in-tag">${escapeHtml(product.danceTag)}</span></div>`;
    } else if (dancesList.length > 0) {
      usedInHtml = `<div class="used-in"><span>Danza:</span> ${dancesList.map((n) => `<span class="used-in-tag">${escapeHtml(n)}</span>`).join('')}</div>`;
    }

    const photoHtml = product.photo
      ? `<img src="${product.photo}" alt="Foto de ${escapeHtml(product.name)}">`
      : `<span class="placeholder-icon">${ICON_GARMENT}</span>`;

    const card = document.createElement('article');
    card.className = 'card product-card';
    card.innerHTML = `
      <div class="card-photo" style="cursor:pointer;" data-edit-product="${product.id}">
        ${photoHtml}
      </div>
      <div class="card-body">
        <div class="card-header">
          <h3 style="cursor:pointer;" data-edit-product="${product.id}">${escapeHtml(product.name)}</h3>
          ${usedInHtml}
        </div>
        ${middleContentHtml}
        <div class="card-actions">
          <button type="button" data-edit-product="${product.id}">Editar prenda</button>
        </div>
      </div>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll('[data-edit-product]').forEach((btn) => {
    btn.addEventListener('click', () => openProductModal(btn.dataset.editProduct));
  });
}

/* ========================= RENDER: DANZAS ========================= */

function renderDances() {
  const grid = document.getElementById('dances-grid');
  const empty = document.getElementById('dances-empty');
  const searchInput = document.getElementById('search-danzas');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const list = state.dances.filter((d) => {
    if (!query) return true;
    const nameMatch = d.name && d.name.toLowerCase().includes(query);
    const reqsMatch = (d.requirements || []).some((productId) => {
      const p = state.products.find((prod) => prod.id === productId);
      return p && p.name && p.name.toLowerCase().includes(query);
    });
    return nameMatch || reqsMatch;
  });

  grid.innerHTML = '';
  const noDancesAtAll = state.dances.length === 0;
  empty.classList.toggle('hidden', !noDancesAtAll);

  if (noDancesAtAll) {
    empty.innerHTML = (!isAdmin || isCatalogMode)
      ? 'Aún no hay danzas publicadas en el catálogo.'
      : 'No hay danzas registradas. Haz clic en <strong>«+ Agregar danza»</strong> para registrar una danza y sus prendas.';
    return;
  }

  if (list.length === 0) {
    grid.innerHTML = `<p class="empty-state" style="grid-column:1/-1">No se encontraron danzas que coincidan con la búsqueda.</p>`;
    return;
  }

  list.forEach((dance) => {
    const photoHtml = dance.photo
      ? `<img src="${dance.photo}" alt="Foto de ${escapeHtml(dance.name)}">`
      : `<span class="placeholder-icon">${ICON_DANCE}</span>`;

    const totalGarments = (dance.requirements || []).length;
    const reqsHtml = (dance.requirements || []).map((productId) => {
      const product = state.products.find((p) => p.id === productId);
      const name = product ? product.name : '(prenda eliminada)';
      return `
        <li class="dance-garment-item">
          <span class="dance-garment-bullet">•</span>
          <span>${escapeHtml(name)}</span>
        </li>
      `;
    }).join('') || '<li class="dance-garment-empty">Sin prendas asignadas</li>';

    let cardActionsHtml = '';
    const whatsappText = encodeURIComponent(`Hola YAWAR INKA, deseo consultar por el vestuario de la danza ${dance.name}`);
    const whatsappUrl = `https://wa.me/${WHATSAPP_PHONE}?text=${whatsappText}`;

    if (!isAdmin || isCatalogMode) {
      // Modo catálogo para clientes: Solo ver detalle y consultar por WhatsApp
      cardActionsHtml = `
        <div class="catalog-card-actions">
          <button type="button" class="btn-catalog-view-detail" data-view-dance="${dance.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
            Ver vestuario
          </button>
          <a href="${whatsappUrl}" target="_blank" rel="noopener noreferrer" class="btn-catalog-consult">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12.031 6.172c-3.181 0-5.767 2.586-5.768 5.766-.001 1.298.38 2.27 1.019 3.287l-.711 2.598 2.664-.699c.963.54 1.777.838 2.796.838 3.185 0 5.77-2.587 5.77-5.769.001-3.182-2.583-5.771-5.77-5.771zm3.392 8.244c-.144.405-.837.774-1.17.824-.299.045-.677.063-1.092-.069-.252-.08-.575-.187-.988-.365-1.739-.751-2.874-2.502-2.961-2.617-.087-.116-.708-.94-.708-1.793s.448-1.273.607-1.446c.159-.173.346-.217.462-.217l.332.006c.106.005.249-.04.39.298.144.347.491 1.2.534 1.287.043.087.072.188.014.304-.058.116-.087.188-.173.289l-.26.304c-.087.086-.177.18-.076.354.101.174.449.741.964 1.201.662.591 1.221.774 1.394.86s.275.072.376-.044c.101-.116.433-.506.549-.68.116-.173.231-.145.39-.087s1.011.477 1.184.564.289.13.332.202c.043.073.043.419-.101.824z"/></svg>
            Consultar
          </a>
        </div>
      `;
    } else {
      // Modo administrador: Permite editar o previsualizar
      cardActionsHtml = `
        <div class="card-actions" style="display:flex; gap:8px;">
          <button data-edit-dance="${dance.id}" style="flex:1;">Editar danza</button>
          <button type="button" class="btn-ghost" data-view-dance="${dance.id}" style="padding:6px 12px; font-size:12.5px;" title="Ver como cliente">
            Vista cliente
          </button>
        </div>
      `;
    }

    const card = document.createElement('article');
    card.className = 'card dance-card';
    card.innerHTML = `
      <div class="card-photo" style="cursor:pointer;" data-view-dance="${dance.id}">${photoHtml}</div>
      <div class="card-body">
        <div class="card-header">
          <h3>${escapeHtml(dance.name)}</h3>
          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:2px;">
            <span style="font-size:12px; color:var(--ink-soft); font-weight:600;">Prendas que incluye el traje:</span>
            <span class="badge" style="font-size:11px;">${totalGarments} piezas</span>
          </div>
        </div>
        <ul class="dance-garments-list">${reqsHtml}</ul>
        ${cardActionsHtml}
      </div>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll('[data-edit-dance]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDanceModal(btn.dataset.editDance);
    });
  });

  grid.querySelectorAll('[data-view-dance]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDanceDetailModal(btn.dataset.viewDance);
    });
  });
}

/* ========================= RENDER: PANEL DE STOCK DISPONIBLE ========================= */

function renderAvailabilityPanel() {
  const grid = document.getElementById('availability-grid');
  grid.innerHTML = '';

  if (state.products.length === 0) {
    grid.innerHTML = `<p style="grid-column:1/-1; color:var(--ink-faint); font-size:13px;">No hay prendas registradas en el inventario.</p>`;
    return;
  }

  state.products.forEach((product) => {
    const availData = getAvailableStockForProduct(product.id);
    if (!availData) return;

    let bodyHtml = '';
    const badgeClass = availData.available > 0 ? 'ok' : 'low';
    const badgeText = `${availData.available} disponibles de ${availData.total}`;

    if (availData.hasSizes === false) {
      bodyHtml = `
        <div style="font-size:13px; color:var(--ink-soft);">
          En almacén: <strong>${availData.total}</strong> | En préstamo: <strong>${availData.rented}</strong>
        </div>
      `;
    } else {
      const pills = sortedSizeEntries(availData.sizes).map(([size, info]) => {
        const isZero = info.available === 0;
        return `
          <div class="avail-size-pill ${isZero ? 'zero' : ''}">
            <b>Talla ${escapeHtml(size)}:</b>
            <span>${info.available} libres</span>
            <span style="color:var(--ink-faint); font-size:11px;">(de ${info.total})</span>
          </div>
        `;
      }).join('') || '<span style="font-size:12px; color:var(--ink-faint);">Sin tallas</span>';

      bodyHtml = `<div class="avail-sizes-grid">${pills}</div>`;
    }

    const card = document.createElement('div');
    card.className = 'avail-card';
    card.innerHTML = `
      <div class="avail-card-head">
        <h4>${escapeHtml(product.name)}</h4>
        <span class="avail-card-badge ${badgeClass}">${badgeText}</span>
      </div>
      ${bodyHtml}
    `;
    grid.appendChild(card);
  });
}

document.getElementById('btn-toggle-availability-panel').addEventListener('click', () => {
  const panel = document.getElementById('availability-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    renderAvailabilityPanel();
  }
});

document.getElementById('btn-close-availability').addEventListener('click', () => {
  document.getElementById('availability-panel').classList.add('hidden');
});

/* ========================= RENDER: ALQUILERES ========================= */

function formatTime12h(timeStr) {
  if (!timeStr) return '';
  const parts = timeStr.split(':');
  let h = parseInt(parts[0], 10);
  const m = parts[1] || '00';
  if (isNaN(h)) return timeStr;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function formatDateFriendly(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

function getRentalTimeStatus(rental) {
  if (rental.status !== 'active') {
    return { type: 'returned', label: 'Devuelto', pillClass: 'status-returned' };
  }

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  // Devolución
  if (rental.dateReturn) {
    if (rental.dateReturn < todayStr) {
      return { type: 'overdue', label: '⚠️ Devolución atrasada', pillClass: 'status-overdue' };
    }
    if (rental.dateReturn === todayStr) {
      return { type: 'today_return', label: '🔄 Devolución programada para HOY', pillClass: 'status-today' };
    }
  }

  // Entrega / Salida
  if (rental.dateOut) {
    if (rental.dateOut === todayStr) {
      return { type: 'today_out', label: '📦 Entrega programada para HOY', pillClass: 'status-today' };
    }
  }

  return { type: 'active', label: 'En préstamo', pillClass: 'status-active' };
}

function renderRentalsSummary(filteredCount) {
  const el = document.getElementById('summary-alquileres');
  const totalRentals = state.rentals.length;
  const activeRentals = state.rentals.filter((r) => r.status === 'active').length;
  const returnedRentals = totalRentals - activeRentals;

  let prendasEnPrestamo = 0;
  state.rentals.filter((r) => r.status === 'active').forEach((r) => {
    (r.items || []).forEach((item) => {
      if (item.sizes) {
        Object.values(item.sizes).forEach((q) => (prendasEnPrestamo += Number(q || 0)));
      }
      if (item.directQty) prendasEnPrestamo += Number(item.directQty || 0);
    });
  });

  el.innerHTML = `
    <div class="summary-chip">En préstamo: <strong>${activeRentals}</strong> alquileres (<strong>${prendasEnPrestamo}</strong> prendas fuera)</div>
    <div class="summary-chip">Devueltos: <strong>${returnedRentals}</strong></div>
    <div class="summary-chip">Total registros: <strong>${totalRentals}</strong></div>
  `;
}

function renderRentals() {
  const grid = document.getElementById('rentals-grid');
  const empty = document.getElementById('rentals-empty');
  const searchInput = document.getElementById('search-alquileres');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const list = state.rentals.filter((r) => {
    if (currentRentalFilter === 'active' && r.status !== 'active') return false;
    if (currentRentalFilter === 'returned' && r.status !== 'returned') return false;

    if (!query) return true;
    const clientMatch = r.client && r.client.toLowerCase().includes(query);
    const contactMatch = r.contact && r.contact.toLowerCase().includes(query);
    const danceMatch = (r.danceName && r.danceName.toLowerCase().includes(query)) ||
      (r.danceCustom && r.danceCustom.toLowerCase().includes(query));
    const notesMatch = r.notes && r.notes.toLowerCase().includes(query);
    const dateMatch = r.dateOut && r.dateOut.includes(query);
    const studentsMatch = Array.isArray(r.students) && r.students.some(
      (s) => (s.name && s.name.toLowerCase().includes(query)) || (s.size && s.size.toLowerCase().includes(query))
    );
    const sizesMatch = Object.keys(r.menSizes || {}).concat(Object.keys(r.womenSizes || {})).some(
      (sz) => sz.toLowerCase() === query || `talla ${sz.toLowerCase()}`.includes(query)
    );
    return clientMatch || contactMatch || danceMatch || notesMatch || dateMatch || studentsMatch || sizesMatch;
  });

  renderRentalsSummary(list.length);
  updateNotificationsUI();

  grid.innerHTML = '';
  empty.classList.toggle('hidden', state.rentals.length !== 0);

  if (state.rentals.length !== 0 && list.length === 0) {
    grid.innerHTML = `<p class="empty-state" style="grid-column:1/-1">No se encontraron alquileres con el filtro o búsqueda actual.</p>`;
  }

  list.forEach((rental) => {
    const isActive = rental.status === 'active';
    const timeStatus = getRentalTimeStatus(rental);

    let statusBadgeHtml = '';
    if (timeStatus.type === 'overdue') {
      statusBadgeHtml = `<span class="rental-badge alert-overdue">⚠️ Atrasado</span>`;
    } else if (timeStatus.type === 'today_return' || timeStatus.type === 'today_out') {
      statusBadgeHtml = `<span class="rental-badge alert-today">🔔 Para Hoy</span>`;
    } else if (isActive) {
      statusBadgeHtml = `<span class="rental-badge active">En préstamo</span>`;
    } else {
      statusBadgeHtml = `<span class="rental-badge returned">Devuelto</span>`;
    }

    // Calcular tallas de varones y mujeres
    const menSizes = rental.menSizes || {};
    const womenSizes = rental.womenSizes || {};

    const menEntries = sortedSizeEntries(menSizes).filter(([, q]) => Number(q) > 0);
    const womenEntries = sortedSizeEntries(womenSizes).filter(([, q]) => Number(q) > 0);

    const menTotal = menEntries.reduce((acc, [, q]) => acc + Number(q), 0);
    const womenTotal = womenEntries.reduce((acc, [, q]) => acc + Number(q), 0);
    const grandTotal = menTotal + womenTotal;

    const menRows = menEntries.map(([sz, q]) => `
      <div class="rental-size-line male-line">
        <span class="size-name">Talla ${escapeHtml(sz)}:</span>
        <span class="size-qty">${q}</span>
      </div>
    `).join('');

    const womenRows = womenEntries.map(([sz, q]) => `
      <div class="rental-size-line female-line">
        <span class="size-name">Talla ${escapeHtml(sz)}:</span>
        <span class="size-qty">${q}</span>
      </div>
    `).join('');

    const danceDisplayName = rental.danceCustom || rental.danceName;
    const danceInfo = danceDisplayName
      ? `<span>Danza: <strong>${escapeHtml(danceDisplayName)}</strong></span>`
      : '';

    const contactInfo = rental.contact
      ? `<span>Contacto: <strong>${escapeHtml(rental.contact)}</strong></span>`
      : '';

    // Fecha formateada (limpia y amigable)
    const dateOutFormatted = rental.dateOut ? formatDateFriendly(rental.dateOut) : 'No especificada';
    const dateReturnFormatted = rental.dateReturn ? formatDateFriendly(rental.dateReturn) : '';

    const dateReturnInfo = dateReturnFormatted
      ? `<span>Devolución: <strong>${escapeHtml(dateReturnFormatted)}</strong></span>`
      : '';

    const notesInfo = rental.notes
      ? `<div class="rental-notes-box"><strong>Notas:</strong> ${escapeHtml(rental.notes)}</div>`
      : '';

    const toggleStatusBtn = isActive
      ? `<button class="btn-secondary" data-return-rental="${rental.id}">Marcar como devuelto</button>`
      : `<button class="btn-ghost" data-reopen-rental="${rental.id}">Reabrir préstamo</button>`;

    let viewStudentsBtn = '';
    if (rental.students && rental.students.length > 0) {
      viewStudentsBtn = `
        <button class="btn-ghost" data-view-students="${rental.id}" style="font-size:12.5px; padding:4px 8px;">
          Ver lista (${rental.students.length} personas)
        </button>
      `;
    }

    const card = document.createElement('article');
    card.className = `rental-card ${timeStatus.type === 'overdue' ? 'card-alert-overdue' : ''}`;
    card.innerHTML = `
      <div class="rental-card-head">
        <div>
          <div class="rental-client-title">${escapeHtml(rental.client)}</div>
          <div class="rental-meta-row">
            <span>Salida/Entrega: <strong>${escapeHtml(dateOutFormatted)}</strong></span>
            ${dateReturnInfo}
            ${danceInfo}
            ${contactInfo}
          </div>
        </div>
        ${statusBadgeHtml}
      </div>

      <div class="rental-items-breakdown" style="display:flex; flex-direction:column; gap:8px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <span class="rental-breakdown-title" style="font-size:13px; font-weight:700;">Trajes llevados</span>
          <span style="font-family:var(--font-mono); font-size:13px; font-weight:800; color:var(--ink);">Total: ${grandTotal} trajes</span>
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px;">
          <!-- Varones -->
          <div style="background:#F0F7FF; border:1px solid #BFDBFE; border-radius:8px; padding:8px 10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-size:12.5px; font-weight:700; color:#1E40AF;">Varones (${menTotal} trajes)</span>
            </div>
            <div class="rental-sizes-vertical-list">
              ${menRows || '<span style="font-size:12px; color:var(--ink-faint);">0 trajes</span>'}
            </div>
          </div>

          <!-- Mujeres -->
          <div style="background:#FFF5F9; border:1px solid #FBCFE8; border-radius:8px; padding:8px 10px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
              <span style="font-size:12.5px; font-weight:700; color:#9D174D;">Mujeres (${womenTotal} trajes)</span>
            </div>
            <div class="rental-sizes-vertical-list">
              ${womenRows || '<span style="font-size:12px; color:var(--ink-faint);">0 trajes</span>'}
            </div>
          </div>
        </div>
      </div>

      ${notesInfo}

      <div class="rental-actions-bar">
        ${toggleStatusBtn}
        ${viewStudentsBtn}
        <button class="btn-ghost rental-card-edit-btn" data-edit-rental="${rental.id}" title="Editar alquiler">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          Editar
        </button>
      </div>
    `;
    grid.appendChild(card);
  });

  grid.querySelectorAll('[data-return-rental]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = state.rentals.find((x) => x.id === btn.dataset.returnRental);
      if (r) {
        r.status = 'returned';
        saveState();
        renderRentals();
        renderAvailabilityPanel();
        showToast('Alquiler marcado como devuelto');
      }
    });
  });

  grid.querySelectorAll('[data-reopen-rental]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = state.rentals.find((x) => x.id === btn.dataset.reopenRental);
      if (r) {
        r.status = 'active';
        saveState();
        renderRentals();
        renderAvailabilityPanel();
        showToast('Alquiler reabierto como activo');
      }
    });
  });

  grid.querySelectorAll('[data-edit-rental]').forEach((btn) => {
    btn.addEventListener('click', () => openRentalModal(btn.dataset.editRental));
  });

  grid.querySelectorAll('[data-view-students]').forEach((btn) => {
    btn.addEventListener('click', () => openViewStudentsModal(btn.dataset.viewStudents));
  });
}

document.querySelectorAll('[data-rental-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-rental-filter]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentRentalFilter = btn.dataset.rentalFilter;
    renderRentals();
  });
});

const searchProductsEl = document.getElementById('search-productos');
if (searchProductsEl) {
  searchProductsEl.addEventListener('input', renderProducts);
  searchProductsEl.addEventListener('search', renderProducts);
}

const searchDancesEl = document.getElementById('search-danzas');
if (searchDancesEl) {
  searchDancesEl.addEventListener('input', renderDances);
  searchDancesEl.addEventListener('search', renderDances);
}

const searchRentalsEl = document.getElementById('search-alquileres');
if (searchRentalsEl) {
  searchRentalsEl.addEventListener('input', renderRentals);
  searchRentalsEl.addEventListener('search', renderRentals);
}

/* ========================= GESTIÓN DE TALLAS Y ALUMNOS EN ALQUILERES ========================= */

const DEFAULT_RENTAL_SIZE_PRESETS = ['4', '6', '8', '10', '12', '14', '16', 'S', 'M', 'L', 'XL', 'XXL'];

function renderRentalSizesGrids() {
  const maleGrid = document.getElementById('rental-male-sizes-grid');
  const femaleGrid = document.getElementById('rental-female-sizes-grid');

  // Varones: presets + custom + existing in data
  const maleSizesSet = new Set([...DEFAULT_RENTAL_SIZE_PRESETS, ...editingRentalCustomMaleSizes, ...Object.keys(editingRentalMenSizes)]);
  const maleSorted = Array.from(maleSizesSet).sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });

  maleGrid.innerHTML = maleSorted.map((size) => {
    const qty = Number(editingRentalMenSizes[size] || 0);
    return `
      <div class="rental-size-box">
        <span class="rental-size-box-label">Talla ${escapeHtml(size)}</span>
        <div class="stepper" style="height:32px;">
          <button type="button" class="icon-btn" data-step-gender="male" data-step-size="${escapeHtml(size)}" data-step-dir="-1">−</button>
          <input type="number" min="0" value="${qty}" data-gender-size-input="male" data-size="${escapeHtml(size)}" style="width:44px; font-weight:700;">
          <button type="button" class="icon-btn" data-step-gender="male" data-step-size="${escapeHtml(size)}" data-step-dir="1">+</button>
        </div>
      </div>
    `;
  }).join('');

  // Mujeres: presets + custom + existing in data
  const femaleSizesSet = new Set([...DEFAULT_RENTAL_SIZE_PRESETS, ...editingRentalCustomFemaleSizes, ...Object.keys(editingRentalWomenSizes)]);
  const femaleSorted = Array.from(femaleSizesSet).sort((a, b) => {
    const na = Number(a), nb = Number(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });

  femaleGrid.innerHTML = femaleSorted.map((size) => {
    const qty = Number(editingRentalWomenSizes[size] || 0);
    return `
      <div class="rental-size-box">
        <span class="rental-size-box-label">Talla ${escapeHtml(size)}</span>
        <div class="stepper" style="height:32px;">
          <button type="button" class="icon-btn" data-step-gender="female" data-step-size="${escapeHtml(size)}" data-step-dir="-1">−</button>
          <input type="number" min="0" value="${qty}" data-gender-size-input="female" data-size="${escapeHtml(size)}" style="width:44px; font-weight:700;">
          <button type="button" class="icon-btn" data-step-gender="female" data-step-size="${escapeHtml(size)}" data-step-dir="1">+</button>
        </div>
      </div>
    `;
  }).join('');

  // Eventos de stepper y de input
  [maleGrid, femaleGrid].forEach((grid) => {
    grid.querySelectorAll('[data-step-gender]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const gender = btn.dataset.stepGender;
        const size = btn.dataset.stepSize;
        const dir = Number(btn.dataset.stepDir);
        let newVal = 0;
        if (gender === 'male') {
          const cur = Number(editingRentalMenSizes[size] || 0);
          newVal = Math.max(0, cur + dir);
          editingRentalMenSizes[size] = newVal;
        } else {
          const cur = Number(editingRentalWomenSizes[size] || 0);
          newVal = Math.max(0, cur + dir);
          editingRentalWomenSizes[size] = newVal;
        }
        const input = grid.querySelector(`[data-gender-size-input="${gender}"][data-size="${size}"]`);
        if (input) {
          input.value = newVal;
        }
        updateRentalTotalsDisplay();
      });
    });

    grid.querySelectorAll('[data-gender-size-input]').forEach((input) => {
      input.addEventListener('input', (e) => {
        const gender = e.target.dataset.genderSizeInput;
        const size = e.target.dataset.size;
        const val = Math.max(0, Number(e.target.value || 0));
        if (gender === 'male') {
          editingRentalMenSizes[size] = val;
        } else {
          editingRentalWomenSizes[size] = val;
        }
        updateRentalTotalsDisplay();
      });
    });
  });

  updateRentalTotalsDisplay();
}

function updateRentalTotalsDisplay() {
  let menTotal = 0;
  Object.values(editingRentalMenSizes).forEach((q) => {
    menTotal += Number(q || 0);
  });

  let womenTotal = 0;
  Object.values(editingRentalWomenSizes).forEach((q) => {
    womenTotal += Number(q || 0);
  });

  const grandTotal = menTotal + womenTotal;

  const maleBadge = document.getElementById('rental-male-total-badge');
  if (maleBadge) maleBadge.textContent = `${menTotal} trajes`;

  const femaleBadge = document.getElementById('rental-female-total-badge');
  if (femaleBadge) femaleBadge.textContent = `${womenTotal} trajes`;

  const grandBadge = document.getElementById('rental-grand-total-badge');
  if (grandBadge) {
    grandBadge.textContent = `${grandTotal} trajes (${menTotal} Varones + ${womenTotal} Mujeres)`;
  }
}

// Añadir talla personalizada
document.getElementById('btn-add-male-custom-size').addEventListener('click', () => {
  const size = prompt('Ingresa el nombre o número de la talla para Varones (ej. 2, 18, 38, XXXL):');
  if (size && size.trim()) {
    const cleanSize = size.trim().toUpperCase();
    if (!editingRentalCustomMaleSizes.includes(cleanSize)) {
      editingRentalCustomMaleSizes.push(cleanSize);
    }
    renderRentalSizesGrids();
  }
});

document.getElementById('btn-add-female-custom-size').addEventListener('click', () => {
  const size = prompt('Ingresa el nombre o número de la talla para Mujeres (ej. 2, 18, 38, XXXL):');
  if (size && size.trim()) {
    const cleanSize = size.trim().toUpperCase();
    if (!editingRentalCustomFemaleSizes.includes(cleanSize)) {
      editingRentalCustomFemaleSizes.push(cleanSize);
    }
    renderRentalSizesGrids();
  }
});

// Pegar lista de texto Word / WhatsApp
document.getElementById('btn-toggle-paste-box').addEventListener('click', () => {
  const box = document.getElementById('rental-paste-box');
  box.classList.toggle('hidden');
  if (!box.classList.contains('hidden')) {
    document.getElementById('rental-paste-text').focus();
  }
});

document.getElementById('btn-cancel-paste-box').addEventListener('click', () => {
  document.getElementById('rental-paste-box').classList.add('hidden');
});

document.getElementById('btn-apply-paste-box').addEventListener('click', () => {
  const text = document.getElementById('rental-paste-text').value;
  if (!text.trim()) {
    showToast('Pega el texto de la lista primero');
    return;
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let importedCount = 0;

  lines.forEach((line) => {
    // Limpiar número de orden inicial: "1. ", "2- ", "(3) "
    let cleanLine = line.replace(/^\d+[\.\-\)\s]+/, '').trim();
    if (!cleanLine) return;

    // Detectar género
    let gender = 'male';
    const lower = cleanLine.toLowerCase();
    if (lower.includes('mujer') || lower.includes('femenino') || lower.includes(' f ') || lower.includes('(f)') || lower.includes('- f') || lower.includes('- m -') || lower.includes('niña') || lower.includes('dama')) {
      gender = 'female';
    } else if (lower.includes('varon') || lower.includes('varón') || lower.includes('masculino') || lower.includes(' v ') || lower.includes('(v)') || lower.includes('- v') || lower.includes('niño') || lower.includes('caballero')) {
      gender = 'male';
    }

    // Detectar talla
    let size = 'M';
    const sizeMatch = cleanLine.match(/(?:T\.?|Talla\s*)?([0-9]{1,2}|XXXL|XXL|XL|XS|[SML])\b/i);
    if (sizeMatch) {
      size = sizeMatch[1].toUpperCase();
    }

    // Limpiar nombre
    let name = cleanLine
      .replace(/(?:T\.?|Talla\s*)?([0-9]{1,2}|XXXL|XXL|XL|XS|[SML])\b/gi, '')
      .replace(/\b(varon|varón|mujer|masculino|femenino|dama|caballero|v|f)\b/gi, '')
      .replace(/[\-\|\,\:\;]+/g, ' ')
      .trim();

    if (!name) name = `Persona ${editingRentalStudents.length + 1}`;

    // Agregar a la lista de estudiantes
    editingRentalStudents.push({
      id: uid('st'),
      name,
      gender,
      size
    });

    // Sumar automáticamente al conteo de tallas de Varones o Mujeres
    if (gender === 'male') {
      editingRentalMenSizes[size] = (Number(editingRentalMenSizes[size]) || 0) + 1;
    } else {
      editingRentalWomenSizes[size] = (Number(editingRentalWomenSizes[size]) || 0) + 1;
    }

    importedCount++;
  });

  document.getElementById('rental-paste-text').value = '';
  document.getElementById('rental-paste-box').classList.add('hidden');
  renderRentalSizesGrids();
  renderStudentsEditor();
  showToast(`Se importaron ${importedCount} personas y se sumaron sus tallas`);
});

// Lista de alumnos / integrantes
function renderStudentsEditor() {
  const indicator = document.getElementById('students-count-indicator');
  if (indicator) {
    indicator.textContent = `${editingRentalStudents.length} personas`;
  }

  const tbody = document.getElementById('students-table-body');
  if (!tbody) return;

  if (editingRentalStudents.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center; padding:12px; color:var(--ink-faint);">
          Sin nombres registrados. Opcional: puedes agregar nombres individuales arriba o pegar una lista.
        </td>
      </tr>
    `;
  } else {
    tbody.innerHTML = editingRentalStudents.map((st, idx) => {
      const isMale = st.gender === 'male';
      const badgeClass = isMale ? 'gender-badge-male' : 'gender-badge-female';
      const dotClass = isMale ? 'gender-dot-male' : 'gender-dot-female';
      const genderLabel = isMale ? 'Varón' : 'Mujer';

      return `
        <tr data-student-idx="${idx}">
          <td style="font-family:var(--font-mono); font-size:12px; color:var(--ink-faint); padding:6px 8px;">${idx + 1}</td>
          <td style="font-weight:600; padding:6px 8px;">${escapeHtml(st.name || '(Sin nombre)')}</td>
          <td style="padding:6px 8px;">
            <span class="gender-badge ${badgeClass}">
              <span class="gender-dot ${dotClass}"></span>
              ${genderLabel}
            </span>
          </td>
          <td style="font-family:var(--font-mono); font-weight:700; padding:6px 8px;">Talla ${escapeHtml(st.size)}</td>
          <td style="text-align:center; padding:6px 8px;">
            <button type="button" class="icon-btn remove-x" data-remove-student="${idx}" title="Eliminar persona">✕</button>
          </td>
        </tr>
      `;
    }).join('');

    tbody.querySelectorAll('[data-remove-student]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.removeStudent);
        const removed = editingRentalStudents[idx];
        if (removed) {
          // Descontar del total si es necesario
          const sz = removed.size;
          if (removed.gender === 'male' && editingRentalMenSizes[sz]) {
            editingRentalMenSizes[sz] = Math.max(0, editingRentalMenSizes[sz] - 1);
          } else if (removed.gender === 'female' && editingRentalWomenSizes[sz]) {
            editingRentalWomenSizes[sz] = Math.max(0, editingRentalWomenSizes[sz] - 1);
          }
        }
        editingRentalStudents.splice(idx, 1);
        renderRentalSizesGrids();
        renderStudentsEditor();
      });
    });
  }
}

// Agregar alumno individual
document.getElementById('btn-add-student').addEventListener('click', () => {
  const nameInput = document.getElementById('new-student-name');
  const name = nameInput.value.trim();
  if (!name) {
    showToast('Escribe los apellidos y nombres');
    nameInput.focus();
    return;
  }
  const gender = document.querySelector('input[name="new-student-gender"]:checked').value;
  const size = document.getElementById('new-student-size').value;

  editingRentalStudents.push({
    id: uid('st'),
    name,
    gender,
    size
  });

  // Sumar automáticamente al conteo de tallas
  if (gender === 'male') {
    editingRentalMenSizes[size] = (Number(editingRentalMenSizes[size]) || 0) + 1;
  } else {
    editingRentalWomenSizes[size] = (Number(editingRentalWomenSizes[size]) || 0) + 1;
  }

  nameInput.value = '';
  nameInput.focus();
  renderRentalSizesGrids();
  renderStudentsEditor();
});

document.getElementById('new-student-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('btn-add-student').click();
  }
});

// Modal de visualización de lista de personas
function openViewStudentsModal(rentalId) {
  const rental = state.rentals.find((r) => r.id === rentalId);
  if (!rental || !rental.students || rental.students.length === 0) {
    showToast('Este alquiler no tiene lista de personas detallada');
    return;
  }

  const danceName = rental.danceCustom || rental.danceName || 'General';
  document.getElementById('modal-view-students-subtitle').textContent = `Cliente: ${rental.client} — Danza: ${danceName}`;

  const summaryBox = document.getElementById('modal-view-students-summary');
  const tbody = document.getElementById('modal-view-students-tbody');

  const menEntries = sortedSizeEntries(rental.menSizes || {}).filter(([, q]) => Number(q) > 0);
  const womenEntries = sortedSizeEntries(rental.womenSizes || {}).filter(([, q]) => Number(q) > 0);

  const menRows = menEntries.map(([sz, q]) => `
    <div class="rental-size-line male-line">
      <span class="size-name">Talla ${escapeHtml(sz)}:</span>
      <span class="size-qty">${q}</span>
    </div>
  `).join('');

  const womenRows = womenEntries.map(([sz, q]) => `
    <div class="rental-size-line female-line">
      <span class="size-name">Talla ${escapeHtml(sz)}:</span>
      <span class="size-qty">${q}</span>
    </div>
  `).join('');

  const menTotal = menEntries.reduce((acc, [, q]) => acc + Number(q), 0);
  const womenTotal = womenEntries.reduce((acc, [, q]) => acc + Number(q), 0);

  summaryBox.innerHTML = `
    <div class="summary-gender-card male-card">
      <div class="summary-gender-title">
        <span>Varones (${menTotal} trajes)</span>
      </div>
      <div class="rental-sizes-vertical-list">
        ${menRows || '<span style="font-size:12px; color:var(--ink-faint);">Sin varones</span>'}
      </div>
    </div>
    <div class="summary-gender-card female-card">
      <div class="summary-gender-title">
        <span>Mujeres (${womenTotal} trajes)</span>
      </div>
      <div class="rental-sizes-vertical-list">
        ${womenRows || '<span style="font-size:12px; color:var(--ink-faint);">Sin mujeres</span>'}
      </div>
    </div>
  `;

  tbody.innerHTML = rental.students.map((st, idx) => {
    const isMale = st.gender === 'male';
    const badgeClass = isMale ? 'gender-badge-male' : 'gender-badge-female';
    const dotClass = isMale ? 'gender-dot-male' : 'gender-dot-female';
    const genderLabel = isMale ? 'Varón' : 'Mujer';

    return `
      <tr>
        <td style="font-family:var(--font-mono); font-size:12px; color:var(--ink-faint); padding:6px 10px;">${idx + 1}</td>
        <td style="font-weight:600; padding:6px 10px;">${escapeHtml(st.name || '(Sin nombre)')}</td>
        <td style="padding:6px 10px;">
          <span class="gender-badge ${badgeClass}">
            <span class="gender-dot ${dotClass}"></span>
            ${genderLabel}
          </span>
        </td>
        <td style="font-family:var(--font-mono); font-weight:700; padding:6px 10px;">Talla ${escapeHtml(st.size)}</td>
      </tr>
    `;
  }).join('');

  openModal('modal-view-students');
}

/* ========================= MODAL: ALQUILER ========================= */

function fillRentalDanceDatalist() {
  const datalist = document.getElementById('rental-dance-datalist');
  if (!datalist) return;
  datalist.innerHTML = state.dances.map((d) => `<option value="${escapeHtml(d.name)}"></option>`).join('');
}

function openRentalModal(rentalId) {
  editingRentalId = rentalId || null;
  const rental = rentalId ? state.rentals.find((r) => r.id === rentalId) : null;

  document.getElementById('modal-rental-title').textContent = rental ? 'Editar Alquiler' : 'Registrar Alquiler';
  document.getElementById('rental-id').value = rentalId || '';
  document.getElementById('rental-client').value = rental ? rental.client : '';
  document.getElementById('rental-contact').value = rental ? (rental.contact || '') : '';
  document.getElementById('rental-date-out').value = rental ? (rental.dateOut || '') : new Date().toISOString().slice(0, 10);
  document.getElementById('rental-date-return').value = rental ? (rental.dateReturn || '') : '';
  
  const alertAdvanceSelect = document.getElementById('rental-alert-advance');
  if (alertAdvanceSelect) {
    alertAdvanceSelect.value = rental && rental.alertAdvance ? rental.alertAdvance : 'today';
  }

  const danceInput = document.getElementById('rental-dance-input');
  if (danceInput) {
    danceInput.value = rental ? (rental.danceCustom || rental.danceName || '') : '';
  }

  document.getElementById('rental-notes').value = rental ? (rental.notes || '') : '';
  document.getElementById('btn-delete-rental').classList.toggle('hidden', !rental);

  // Copiar tallas de varones y mujeres
  editingRentalMenSizes = rental && rental.menSizes ? JSON.parse(JSON.stringify(rental.menSizes)) : {};
  editingRentalWomenSizes = rental && rental.womenSizes ? JSON.parse(JSON.stringify(rental.womenSizes)) : {};
  editingRentalStudents = rental && Array.isArray(rental.students) ? JSON.parse(JSON.stringify(rental.students)) : [];
  editingRentalCustomMaleSizes = [];
  editingRentalCustomFemaleSizes = [];

  // Ocultar cuadro de pegar si estaba abierto
  const pasteBox = document.getElementById('rental-paste-box');
  if (pasteBox) pasteBox.classList.add('hidden');
  const pasteText = document.getElementById('rental-paste-text');
  if (pasteText) pasteText.value = '';

  fillRentalDanceDatalist();
  renderRentalSizesGrids();

  openModal('modal-rental');
}

document.getElementById('btn-add-rental').addEventListener('click', () => openRentalModal(null));

document.getElementById('btn-save-rental').addEventListener('click', () => {
  const client = document.getElementById('rental-client').value.trim();
  if (!client) {
    showToast('Escribe el nombre del cliente, colegio o institución');
    return;
  }
  const contact = document.getElementById('rental-contact').value.trim();
  const dateOut = document.getElementById('rental-date-out').value;
  const dateReturn = document.getElementById('rental-date-return').value;
  const alertAdvanceSelect = document.getElementById('rental-alert-advance');
  const alertAdvance = alertAdvanceSelect ? alertAdvanceSelect.value : 'today';
  
  const danceInput = document.getElementById('rental-dance-input');
  const danceEntered = danceInput ? danceInput.value.trim() : '';

  // Buscar si coincide con alguna danza registrada
  const matchedDance = state.dances.find((d) => d.name.trim().toLowerCase() === danceEntered.toLowerCase());
  const danceId = matchedDance ? matchedDance.id : '';
  const danceName = matchedDance ? matchedDance.name : danceEntered;
  const danceCustom = matchedDance ? '' : danceEntered;
  const notes = document.getElementById('rental-notes').value.trim();

  // Limpiar conteo de tallas de varones y mujeres (solo guardar > 0)
  const cleanMenSizes = {};
  Object.entries(editingRentalMenSizes).forEach(([sz, q]) => {
    if (Number(q) > 0) cleanMenSizes[sz] = Number(q);
  });

  const cleanWomenSizes = {};
  Object.entries(editingRentalWomenSizes).forEach(([sz, q]) => {
    if (Number(q) > 0) cleanWomenSizes[sz] = Number(q);
  });

  // Si la danza registrada tiene prendas asociadas, sincronizar el inventario de prendas
  const combinedSizes = {};
  Object.entries(cleanMenSizes).forEach(([sz, q]) => {
    combinedSizes[sz] = (combinedSizes[sz] || 0) + Number(q);
  });
  Object.entries(cleanWomenSizes).forEach(([sz, q]) => {
    combinedSizes[sz] = (combinedSizes[sz] || 0) + Number(q);
  });
  const totalCombined = Object.values(combinedSizes).reduce((acc, val) => acc + val, 0);

  let cleanItems = [];
  if (matchedDance && Array.isArray(matchedDance.requirements) && matchedDance.requirements.length > 0) {
    cleanItems = matchedDance.requirements.map((prodId) => {
      const prod = state.products.find((p) => p.id === prodId);
      if (prod && prod.hasSizes === false) {
        return {
          productId: prodId,
          sizes: {},
          directQty: totalCombined
        };
      } else {
        return {
          productId: prodId,
          sizes: { ...combinedSizes },
          directQty: 0
        };
      }
    });
  }

  if (editingRentalId) {
    const rental = state.rentals.find((r) => r.id === editingRentalId);
    rental.client = client;
    rental.contact = contact;
    rental.dateOut = dateOut;
    rental.dateReturn = dateReturn;
    rental.alertAdvance = alertAdvance;
    rental.danceId = danceId;
    rental.danceName = danceName;
    rental.danceCustom = danceCustom;
    rental.menSizes = cleanMenSizes;
    rental.womenSizes = cleanWomenSizes;
    rental.items = cleanItems;
    rental.students = [...editingRentalStudents];
    rental.notes = notes;
    showToast('Alquiler actualizado');
  } else {
    state.rentals.unshift({
      id: uid('rent'),
      client,
      contact,
      dateOut,
      dateReturn,
      alertAdvance,
      danceId,
      danceName,
      danceCustom,
      status: 'active',
      menSizes: cleanMenSizes,
      womenSizes: cleanWomenSizes,
      items: cleanItems,
      students: [...editingRentalStudents],
      notes,
    });
    showToast('Alquiler registrado correctamente');
  }

  saveState();
  renderRentals();
  renderAvailabilityPanel();
  checkAndTriggerNotifications();
  closeModal('modal-rental');
});

  saveState();
  renderRentals();
  renderAvailabilityPanel();
  checkAndTriggerNotifications();
  closeModal('modal-rental');
});

document.getElementById('btn-delete-rental').addEventListener('click', () => {
  if (!editingRentalId) return;
  if (!confirm('¿Eliminar este registro de alquiler?')) return;
  state.rentals = state.rentals.filter((r) => r.id !== editingRentalId);
  saveState();
  renderRentals();
  renderAvailabilityPanel();
  closeModal('modal-rental');
  showToast('Alquiler eliminado');
});

/* ========================= MODAL: PRODUCTO ========================= */

function updateProductModalSizeType() {
  const isWithSizes = document.getElementById('type-with-sizes').checked;
  editingProductHasSizes = isWithSizes;
  document.getElementById('section-with-sizes').classList.toggle('hidden', !isWithSizes);
  document.getElementById('section-no-sizes').classList.toggle('hidden', isWithSizes);
}

document.getElementById('type-with-sizes').addEventListener('change', updateProductModalSizeType);
document.getElementById('type-no-sizes').addEventListener('change', updateProductModalSizeType);

function fillSizeSelectOptions() {
  const select = document.getElementById('new-size-select');
  const used = Object.keys(editingSizes);
  select.innerHTML = '<option value="">Elegir talla...</option>' +
    SIZE_PRESETS.filter((s) => !used.includes(s)).map((s) => `<option value="${s}">Talla ${s}</option>`).join('') +
    '<option value="__custom__">Otra talla personalizada...</option>';
}

function renderSizesEditor() {
  const container = document.getElementById('product-sizes-list');
  const entries = sortedSizeEntries(editingSizes);
  if (entries.length === 0) {
    container.innerHTML = `<p style="color:var(--ink-faint); font-size:13px; margin:0;">No hay tallas agregadas.</p>`;
  } else {
    container.innerHTML = entries.map(([label, qty]) => `
      <div class="size-edit-row" data-size="${escapeHtml(label)}">
        <span class="size-label-edit">Talla ${escapeHtml(label)}</span>
        <div class="stepper">
          <button type="button" class="icon-btn" data-step="-1" title="Restar 1">−</button>
          <input type="number" min="0" value="${qty}" data-qty-input title="Cantidad">
          <button type="button" class="icon-btn" data-step="1" title="Sumar 1">+</button>
        </div>
        <button type="button" class="icon-btn remove-x" data-remove-size title="Eliminar talla">✕</button>
      </div>
    `).join('');
  }

  container.querySelectorAll('.size-edit-row').forEach((row) => {
    const label = row.dataset.size;
    row.querySelector('[data-qty-input]').addEventListener('input', (e) => {
      editingSizes[label] = Math.max(0, Number(e.target.value || 0));
    });
    row.querySelectorAll('[data-step]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const delta = Number(btn.dataset.step);
        editingSizes[label] = Math.max(0, Number(editingSizes[label] || 0) + delta);
        renderSizesEditor();
      });
    });
    row.querySelector('[data-remove-size]').addEventListener('click', () => {
      delete editingSizes[label];
      renderSizesEditor();
      fillSizeSelectOptions();
    });
  });

  fillSizeSelectOptions();
}

document.getElementById('new-size-select').addEventListener('change', (e) => {
  const customInput = document.getElementById('new-size-custom');
  customInput.classList.toggle('hidden', e.target.value !== '__custom__');
  if (e.target.value === '__custom__') customInput.focus();
});

document.getElementById('btn-add-size').addEventListener('click', () => {
  const select = document.getElementById('new-size-select');
  const customInput = document.getElementById('new-size-custom');
  const qtyInput = document.getElementById('new-size-qty');

  let label = select.value;
  if (label === '__custom__') label = customInput.value.trim().toUpperCase();
  if (!label) {
    showToast('Selecciona o escribe una talla');
    return;
  }
  if (editingSizes[label] !== undefined) {
    showToast('Esa talla ya existe');
    return;
  }
  editingSizes[label] = Math.max(0, Number(qtyInput.value || 0));
  select.value = '';
  customInput.value = '';
  customInput.classList.add('hidden');
  qtyInput.value = 1;
  renderSizesEditor();
});

function openProductModal(productId) {
  editingProductId = productId || null;
  const product = productId ? state.products.find((p) => p.id === productId) : null;

  document.getElementById('modal-product-title').textContent = product ? 'Editar prenda' : 'Agregar prenda';
  document.getElementById('product-id').value = productId || '';
  document.getElementById('product-name').value = product ? product.name : '';
  document.getElementById('product-dance-tag').value = product && product.danceTag ? product.danceTag : '';
  document.getElementById('btn-delete-product').classList.toggle('hidden', !product);

  const hasSizes = product ? (product.hasSizes !== false) : true;
  document.getElementById('type-with-sizes').checked = hasSizes;
  document.getElementById('type-no-sizes').checked = !hasSizes;
  updateProductModalSizeType();

  editingSizes = product && product.sizes ? { ...product.sizes } : {};
  document.getElementById('product-direct-qty').value = product && product.totalDirectQty !== undefined ? product.totalDirectQty : 1;

  setProductPhoto(product ? product.photo : null);

  document.getElementById('new-size-select').value = '';
  document.getElementById('new-size-custom').value = '';
  document.getElementById('new-size-custom').classList.add('hidden');
  document.getElementById('new-size-qty').value = 1;

  renderSizesEditor();
  openModal('modal-product');
}

document.getElementById('btn-add-product').addEventListener('click', () => openProductModal(null));

document.getElementById('btn-save-product').addEventListener('click', () => {
  const name = document.getElementById('product-name').value.trim();
  if (!name) {
    showToast('Escribe el nombre de la prenda');
    return;
  }
  const danceTag = document.getElementById('product-dance-tag').value.trim();
  const isWithSizes = document.getElementById('type-with-sizes').checked;
  const directQty = Math.max(0, Number(document.getElementById('product-direct-qty').value || 0));

  if (editingProductId) {
    const product = state.products.find((p) => p.id === editingProductId);
    product.name = name;
    product.danceTag = danceTag;
    product.hasSizes = isWithSizes;
    product.sizes = isWithSizes ? { ...editingSizes } : {};
    product.totalDirectQty = isWithSizes ? 0 : directQty;
    product.photo = editingProductPhoto;
    showToast('Prenda guardada');
  } else {
    state.products.push({
      id: uid('prod'),
      name,
      danceTag,
      hasSizes: isWithSizes,
      sizes: isWithSizes ? { ...editingSizes } : {},
      totalDirectQty: isWithSizes ? 0 : directQty,
      photo: editingProductPhoto,
    });
    showToast('Prenda registrada');
  }
  saveState();
  renderAll();
  closeModal('modal-product');
});

document.getElementById('btn-delete-product').addEventListener('click', () => {
  if (!editingProductId) return;
  if (!confirm('¿Eliminar esta prenda?')) return;
  state.products = state.products.filter((p) => p.id !== editingProductId);
  state.dances.forEach((d) => {
    d.requirements = (d.requirements || []).filter((id) => id !== editingProductId);
  });
  state.rentals.forEach((r) => {
    r.items = (r.items || []).filter((it) => it.productId !== editingProductId);
  });
  saveState();
  renderAll();
  closeModal('modal-product');
  showToast('Prenda eliminada');
});

/* ========================= FOTOS & CÁMARA ========================= */

function openLiveCamera(onCapture) {
  onPhotoCapturedCallback = onCapture;
  const modalCam = document.getElementById('modal-camera-capture');
  const video = document.getElementById('camera-stream');

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false
    }).then((stream) => {
      currentCameraStream = stream;
      video.srcObject = stream;
      modalCam.classList.remove('hidden');
    }).catch((err) => {
      console.warn('Error al iniciar cámara:', err);
      fallbackNativeCamera(onCapture);
    });
  } else {
    fallbackNativeCamera(onCapture);
  }
}

function closeLiveCamera() {
  const modalCam = document.getElementById('modal-camera-capture');
  const video = document.getElementById('camera-stream');
  if (currentCameraStream) {
    currentCameraStream.getTracks().forEach((track) => track.stop());
    currentCameraStream = null;
  }
  if (video) video.srcObject = null;
  modalCam.classList.add('hidden');
}

function fallbackNativeCamera(onCapture) {
  const isProduct = (onCapture === setProductPhoto);
  const input = document.getElementById(isProduct ? 'product-photo-camera' : 'dance-photo-camera');
  if (input) {
    input.onchange = () => {
      const file = input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => onCapture(reader.result);
      reader.readAsDataURL(file);
      input.value = '';
    };
    input.click();
  }
}

document.getElementById('btn-close-camera').addEventListener('click', closeLiveCamera);

document.getElementById('btn-snap-photo').addEventListener('click', () => {
  const video = document.getElementById('camera-stream');
  const canvas = document.getElementById('camera-canvas');
  if (!video || !video.videoWidth) return;

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.88);

  if (onPhotoCapturedCallback) {
    onPhotoCapturedCallback(dataUrl);
  }
  closeLiveCamera();
  showToast('Foto capturada');
});

/* ========================= FOTOS & CÁMARA & AJUSTE / RECORTE ========================= */

let cropState = {
  rawImageSrc: null,
  imgElement: null,
  naturalWidth: 1,
  naturalHeight: 1,
  zoom: 1,
  panX: 0,
  panY: 0,
  isDragging: false,
  dragStartX: 0,
  dragStartY: 0,
  onConfirmCallback: null
};

function openCropModal(imageSrc, onConfirm) {
  cropState.rawImageSrc = imageSrc;
  cropState.onConfirmCallback = onConfirm;
  cropState.zoom = 1;
  cropState.panX = 0;
  cropState.panY = 0;

  const targetImg = document.getElementById('crop-target-img');
  const zoomRange = document.getElementById('crop-zoom-range');
  zoomRange.value = '1';

  targetImg.src = imageSrc;
  targetImg.onload = () => {
    cropState.naturalWidth = targetImg.naturalWidth;
    cropState.naturalHeight = targetImg.naturalHeight;
    updateCropTransform();
    openModal('modal-crop-photo');
  };
}

function updateCropTransform() {
  const targetImg = document.getElementById('crop-target-img');
  const viewport = document.getElementById('crop-viewport');
  if (!viewport || !targetImg) return;

  const vpW = viewport.clientWidth || 400;
  const vpH = viewport.clientHeight || 250;
  const scale = Math.max(vpW / cropState.naturalWidth, vpH / cropState.naturalHeight) * cropState.zoom;

  const curW = cropState.naturalWidth * scale;
  const curH = cropState.naturalHeight * scale;

  // Limitar desplazamiento para no salirse del marco
  const maxPanX = Math.max(0, (curW - vpW) / 2);
  const maxPanY = Math.max(0, (curH - vpH) / 2);

  cropState.panX = Math.max(-maxPanX, Math.min(maxPanX, cropState.panX));
  cropState.panY = Math.max(-maxPanY, Math.min(maxPanY, cropState.panY));

  targetImg.style.width = `${curW}px`;
  targetImg.style.height = `${curH}px`;
  targetImg.style.transform = `translate(${cropState.panX}px, ${cropState.panY}px)`;
}

// Dragging / Panning
const cropViewportWrap = document.querySelector('.crop-viewport-wrap');
if (cropViewportWrap) {
  const startDrag = (clientX, clientY) => {
    cropState.isDragging = true;
    cropState.dragStartX = clientX - cropState.panX;
    cropState.dragStartY = clientY - cropState.panY;
  };

  const moveDrag = (clientX, clientY) => {
    if (!cropState.isDragging) return;
    cropState.panX = clientX - cropState.dragStartX;
    cropState.panY = clientY - cropState.dragStartY;
    updateCropTransform();
  };

  const endDrag = () => {
    cropState.isDragging = false;
  };

  cropViewportWrap.addEventListener('mousedown', (e) => startDrag(e.clientX, e.clientY));
  window.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', endDrag);

  cropViewportWrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      startDrag(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (cropState.isDragging && e.touches.length === 1) {
      moveDrag(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  window.addEventListener('touchend', endDrag);
}

// Zoom controls
document.getElementById('crop-zoom-range').addEventListener('input', (e) => {
  cropState.zoom = parseFloat(e.target.value);
  updateCropTransform();
});

document.getElementById('btn-crop-zoom-in').addEventListener('click', () => {
  cropState.zoom = Math.min(3, cropState.zoom + 0.15);
  document.getElementById('crop-zoom-range').value = cropState.zoom.toString();
  updateCropTransform();
});

document.getElementById('btn-crop-zoom-out').addEventListener('click', () => {
  cropState.zoom = Math.max(1, cropState.zoom - 0.15);
  document.getElementById('crop-zoom-range').value = cropState.zoom.toString();
  updateCropTransform();
});

document.getElementById('btn-crop-reset').addEventListener('click', () => {
  cropState.zoom = 1;
  cropState.panX = 0;
  cropState.panY = 0;
  document.getElementById('crop-zoom-range').value = '1';
  updateCropTransform();
});

document.getElementById('btn-crop-fit-contain').addEventListener('click', () => {
  cropState.zoom = 1;
  cropState.panX = 0;
  cropState.panY = 0;
  document.getElementById('crop-zoom-range').value = '1';
  updateCropTransform();
});

// Confirm Crop & Generate canvas
document.getElementById('btn-crop-confirm').addEventListener('click', () => {
  const viewport = document.getElementById('crop-viewport');
  const vpW = viewport.clientWidth || 400;
  const vpH = viewport.clientHeight || 250;

  const canvas = document.createElement('canvas');
  // Proporción fija óptima de alta definición (800x500 = 16:10)
  canvas.width = 800;
  canvas.height = 500;
  const ctx = canvas.getContext('2d');

  const scale = Math.max(vpW / cropState.naturalWidth, vpH / cropState.naturalHeight) * cropState.zoom;
  const renderedW = cropState.naturalWidth * scale;
  const renderedH = cropState.naturalHeight * scale;

  // Centro en coordenadas del viewport
  const imgLeft = (vpW - renderedW) / 2 + cropState.panX;
  const imgTop = (vpH - renderedH) / 2 + cropState.panY;

  // Mapear a resolución del canvas
  const canvasScale = canvas.width / vpW;

  const targetImg = document.getElementById('crop-target-img');
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    targetImg,
    imgLeft * canvasScale,
    imgTop * canvasScale,
    renderedW * canvasScale,
    renderedH * canvasScale
  );

  const croppedDataUrl = canvas.toDataURL('image/jpeg', 0.90);
  if (cropState.onConfirmCallback) {
    cropState.onConfirmCallback(croppedDataUrl);
  }
  closeModal('modal-crop-photo');
  showToast('Encuadre ajustado correctamente');
});

function setProductPhoto(dataUrl) {
  editingProductPhoto = dataUrl;
  const preview = document.getElementById('product-photo-preview');
  const placeholder = document.getElementById('product-photo-placeholder');
  const removeBtn = document.getElementById('product-photo-remove');
  const cropBtn = document.getElementById('product-btn-crop');
  if (dataUrl) {
    preview.src = dataUrl;
    preview.classList.remove('hidden');
    placeholder.classList.add('hidden');
    removeBtn.classList.remove('hidden');
    if (cropBtn) cropBtn.classList.remove('hidden');
  } else {
    preview.classList.add('hidden');
    placeholder.classList.remove('hidden');
    removeBtn.classList.add('hidden');
    if (cropBtn) cropBtn.classList.add('hidden');
  }
}

function setDancePhoto(dataUrl) {
  editingDancePhoto = dataUrl;
  const preview = document.getElementById('dance-photo-preview');
  const placeholder = document.getElementById('dance-photo-placeholder');
  const removeBtn = document.getElementById('dance-photo-remove');
  const cropBtn = document.getElementById('dance-btn-crop');
  if (dataUrl) {
    preview.src = dataUrl;
    preview.classList.remove('hidden');
    placeholder.classList.add('hidden');
    removeBtn.classList.remove('hidden');
    if (cropBtn) cropBtn.classList.remove('hidden');
  } else {
    preview.classList.add('hidden');
    placeholder.classList.remove('hidden');
    removeBtn.classList.add('hidden');
    if (cropBtn) cropBtn.classList.add('hidden');
  }
}

document.getElementById('product-btn-camera').addEventListener('click', () => {
  openLiveCamera((dataUrl) => {
    openCropModal(dataUrl, setProductPhoto);
  });
});

document.getElementById('dance-btn-camera').addEventListener('click', () => {
  openLiveCamera((dataUrl) => {
    openCropModal(dataUrl, setDancePhoto);
  });
});

document.getElementById('product-photo-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    openCropModal(reader.result, setProductPhoto);
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

document.getElementById('dance-photo-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    openCropModal(reader.result, setDancePhoto);
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

document.getElementById('product-btn-crop').addEventListener('click', () => {
  if (editingProductPhoto) {
    openCropModal(editingProductPhoto, setProductPhoto);
  }
});

document.getElementById('dance-btn-crop').addEventListener('click', () => {
  if (editingDancePhoto) {
    openCropModal(editingDancePhoto, setDancePhoto);
  }
});

document.getElementById('product-photo-remove').addEventListener('click', () => setProductPhoto(null));
document.getElementById('dance-photo-remove').addEventListener('click', () => setDancePhoto(null));

/* ========================= MODAL: DANZA ========================= */

function fillReqProductSelect() {
  const select = document.getElementById('new-req-product');
  const noProductsMsg = document.getElementById('req-no-products');
  noProductsMsg.classList.toggle('hidden', state.products.length !== 0);

  const unusedProducts = state.products.filter((p) => !editingRequirements.includes(p.id));
  select.innerHTML = '<option value="">Elegir prenda a incluir...</option>' +
    unusedProducts.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
}

function renderRequirementsEditor() {
  const container = document.getElementById('dance-requirements-list');
  if (editingRequirements.length === 0) {
    container.innerHTML = `<p style="color:var(--ink-faint); font-size:13px; margin:0;">No hay prendas incluidas todavía.</p>`;
    return;
  }
  container.innerHTML = editingRequirements.map((productId, idx) => {
    const product = state.products.find((p) => p.id === productId);
    const name = product ? product.name : '(prenda eliminada)';
    return `
      <div class="req-edit-row" data-idx="${idx}">
        <span class="req-edit-text"><b>${escapeHtml(name)}</b></span>
        <button type="button" class="icon-btn remove-x" data-remove-req="${idx}" title="Quitar">✕</button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-remove-req]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editingRequirements.splice(Number(btn.dataset.removeReq), 1);
      renderRequirementsEditor();
      fillReqProductSelect();
    });
  });
}

document.getElementById('btn-add-req').addEventListener('click', () => {
  const productId = document.getElementById('new-req-product').value;
  if (!productId) {
    showToast('Selecciona una prenda');
    return;
  }
  if (editingRequirements.includes(productId)) {
    showToast('Esa prenda ya está incluida');
    return;
  }
  editingRequirements.push(productId);
  renderRequirementsEditor();
  fillReqProductSelect();
});

function openDanceModal(danceId) {
  editingDanceId = danceId || null;
  const dance = danceId ? state.dances.find((d) => d.id === danceId) : null;

  document.getElementById('modal-dance-title').textContent = dance ? 'Editar danza' : 'Agregar danza';
  document.getElementById('dance-id').value = danceId || '';
  document.getElementById('dance-name').value = dance ? dance.name : '';
  document.getElementById('btn-delete-dance').classList.toggle('hidden', !dance);

  editingRequirements = dance ? [...(dance.requirements || [])] : [];
  setDancePhoto(dance ? dance.photo : null);

  fillReqProductSelect();
  renderRequirementsEditor();
  openModal('modal-dance');
}

document.getElementById('btn-add-dance').addEventListener('click', () => openDanceModal(null));

document.getElementById('btn-save-dance').addEventListener('click', () => {
  const name = document.getElementById('dance-name').value.trim();
  if (!name) {
    showToast('Escribe el nombre de la danza');
    return;
  }
  if (editingDanceId) {
    const dance = state.dances.find((d) => d.id === editingDanceId);
    dance.name = name;
    dance.requirements = [...editingRequirements];
    dance.photo = editingDancePhoto;
    showToast('Danza guardada');
  } else {
    state.dances.push({
      id: uid('dance'),
      name,
      requirements: [...editingRequirements],
      photo: editingDancePhoto,
    });
    showToast('Danza agregada');
  }
  saveState();
  renderAll();
  closeModal('modal-dance');
});

document.getElementById('btn-delete-dance').addEventListener('click', () => {
  if (!editingDanceId) return;
  if (!confirm('¿Eliminar esta danza?')) return;
  state.dances = state.dances.filter((d) => d.id !== editingDanceId);
  saveState();
  renderAll();
  closeModal('modal-dance');
  showToast('Danza eliminada');
});

/* ========================= MODALES ========================= */

function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.body.style.overflow = '';
}

document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
});
document.querySelectorAll('.modal-overlay').forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      if (overlay.id === 'modal-camera-capture') closeLiveCamera();
      else closeModal(overlay.id);
    }
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!document.getElementById('modal-camera-capture').classList.contains('hidden')) {
      closeLiveCamera();
    } else {
      document.querySelectorAll('.modal-overlay:not(.hidden)').forEach((m) => closeModal(m.id));
    }
  }
});

/* ========================= RESPALDO JSON (OPCIONAL) ========================= */

const btnExport = document.getElementById('btn-export');
if (btnExport) {
  btnExport.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const fecha = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `yawar-inka-respaldo-${fecha}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Respaldo descargado');
  });
}

const btnImport = document.getElementById('btn-import');
const importFileInput = document.getElementById('import-file');
if (btnImport && importFileInput) {
  btnImport.addEventListener('click', () => {
    importFileInput.click();
  });

  importFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.products) || !Array.isArray(data.dances)) {
          throw new Error('Formato inválido');
        }
        if (!confirm('Esto reemplazará todos los datos actuales con los del archivo. ¿Continuar?')) return;
        state = data;
        if (!Array.isArray(state.rentals)) state.rentals = [];
        saveState();
        renderAll();
        showToast('Respaldo cargado');
      } catch (err) {
        alert('No se pudo leer el archivo de respaldo.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });
}

/* ========================= COMPARTIR CATÁLOGO ========================= */

function getCatalogShareUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set('modo', 'catalogo');
  return url.toString();
}

function openShareCatalogModal() {
  const shareUrl = getCatalogShareUrl();
  const input = document.getElementById('share-catalog-url');
  if (input) input.value = shareUrl;

  const whatsappBtn = document.getElementById('btn-share-whatsapp-link');
  if (whatsappBtn) {
    const text = encodeURIComponent(`¡Hola! Te invito a ver nuestro catálogo de danzas y trajes folclóricos en YAWAR INKA: ${shareUrl}`);
    whatsappBtn.href = `https://wa.me/?text=${text}`;
  }

  openModal('modal-share-catalog');
}

const btnShareDanzasHead = document.getElementById('btn-share-danzas-head');
if (btnShareDanzasHead) btnShareDanzasHead.addEventListener('click', openShareCatalogModal);

const btnCopyUrl = document.getElementById('btn-copy-catalog-url');
if (btnCopyUrl) {
  btnCopyUrl.addEventListener('click', async () => {
    const input = document.getElementById('share-catalog-url');
    if (!input) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(input.value);
      } else {
        input.select();
        document.execCommand('copy');
      }
      showToast('¡Enlace del catálogo copiado!');
    } catch (err) {
      input.select();
      document.execCommand('copy');
      showToast('¡Enlace copiado!');
    }
  });
}

const btnOpenCatalogPreview = document.getElementById('btn-open-catalog-preview');
if (btnOpenCatalogPreview) {
  btnOpenCatalogPreview.addEventListener('click', () => {
    closeModal('modal-share-catalog');
    isCatalogMode = true;
    updateAuthUI();
    renderAll();
    showToast('Visualizando en modo cliente');
  });
}

/* ========================= MODAL: DETALLE DE DANZA PARA CLIENTES ========================= */

function openDanceDetailModal(danceId) {
  const dance = state.dances.find((d) => d.id === danceId);
  if (!dance) return;

  const titleEl = document.getElementById('modal-dance-view-title');
  const nameEl = document.getElementById('dance-view-name');
  const photoImg = document.getElementById('dance-view-photo');
  const photoPlaceholder = document.getElementById('dance-view-placeholder');
  const garmentsListEl = document.getElementById('dance-view-garments');
  const whatsappBtn = document.getElementById('btn-dance-consult-whatsapp');

  if (titleEl) titleEl.textContent = dance.name;
  if (nameEl) nameEl.textContent = dance.name;

  if (photoImg && photoPlaceholder) {
    if (dance.photo) {
      photoImg.src = dance.photo;
      photoImg.alt = `Vestuario de ${dance.name}`;
      photoImg.classList.remove('hidden');
      photoPlaceholder.classList.add('hidden');
    } else {
      photoImg.classList.add('hidden');
      photoPlaceholder.classList.remove('hidden');
    }
  }

  if (garmentsListEl) {
    const reqs = dance.requirements || [];
    if (reqs.length === 0) {
      garmentsListEl.innerHTML = '<li style="color:var(--ink-faint); font-weight:normal;">No se han especificado piezas para esta danza.</li>';
    } else {
      garmentsListEl.innerHTML = reqs.map((prodId, idx) => {
        const prod = state.products.find((p) => p.id === prodId);
        const name = prod ? prod.name : '(Prenda tradicional)';
        return `
          <li>
            <span style="color:var(--accent); font-weight:700;">${idx + 1}.</span>
            <span>${escapeHtml(name)}</span>
          </li>
        `;
      }).join('');
    }
  }

  if (whatsappBtn) {
    const msg = encodeURIComponent(`Hola YAWAR INKA, deseo información y consultar por el vestuario completo de la danza: ${dance.name}`);
    whatsappBtn.href = `https://wa.me/${WHATSAPP_PHONE}?text=${msg}`;
  }

  openModal('modal-dance-view');
}

/* ========================= MODAL: ACCESO Y ADMINISTRACIÓN ========================= */

function openAdminAuthModal() {
  const loggedInView = document.getElementById('admin-logged-in-view');
  const loginFormView = document.getElementById('admin-login-form-view');
  const modalFoot = document.getElementById('admin-login-modal-foot');
  const currentEmailDisplay = document.getElementById('current-admin-email-display');
  const errorEl = document.getElementById('admin-login-error');

  if (errorEl) errorEl.classList.add('hidden');

  if (isAdmin && !isCatalogMode) {
    if (loggedInView) loggedInView.classList.remove('hidden');
    if (loginFormView) loginFormView.classList.add('hidden');
    if (modalFoot) modalFoot.classList.add('hidden');
    if (currentEmailDisplay) currentEmailDisplay.textContent = `Correo: ${currentAdminEmail || ''}`;
  } else {
    if (loggedInView) loggedInView.classList.add('hidden');
    if (loginFormView) loginFormView.classList.remove('hidden');
    if (modalFoot) modalFoot.classList.remove('hidden');
    const input = document.getElementById('admin-email-input');
    const pinInput = document.getElementById('admin-pin-input');
    if (input) input.value = '';
    if (pinInput) pinInput.value = '';
  }

  openModal('modal-admin-login');
}

const btnSubmitAdminLogin = document.getElementById('btn-submit-admin-login');
if (btnSubmitAdminLogin) {
  btnSubmitAdminLogin.addEventListener('click', () => {
    const emailInput = document.getElementById('admin-email-input');
    const pinInput = document.getElementById('admin-pin-input');
    const errorEl = document.getElementById('admin-login-error');
    const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
    const pin = pinInput ? pinInput.value.trim() : '';

    if (!email) {
      if (errorEl) {
        errorEl.textContent = 'Por favor ingresa tu correo de administrador.';
        errorEl.classList.remove('hidden');
      }
      return;
    }

    const isEmailValid = AUTHORIZED_ADMIN_EMAILS.includes(email);
    const isPinValid = ADMIN_PINS.includes(pin);

    if (isEmailValid && isPinValid) {
      currentAdminEmail = email;
      localStorage.setItem(AUTH_STORAGE_KEY, email);
      isAdmin = true;
      isCatalogMode = false;
      closeModal('modal-admin-login');
      updateAuthUI();
      renderAll();
      showToast('¡Sesión iniciada como Administrador!');
    } else {
      if (errorEl) {
        if (!isEmailValid) {
          errorEl.textContent = `El correo "${email}" no está registrado como administrador.`;
        } else {
          errorEl.textContent = 'PIN o clave de seguridad incorrecta.';
        }
        errorEl.classList.remove('hidden');
      }
    }
  });
}

const btnLogoutAdmin = document.getElementById('btn-logout-admin');
if (btnLogoutAdmin) {
  btnLogoutAdmin.addEventListener('click', () => {
    currentAdminEmail = null;
    localStorage.removeItem(AUTH_STORAGE_KEY);
    isAdmin = false;
    isCatalogMode = true;
    closeModal('modal-admin-login');
    updateAuthUI();
    renderAll();
    showToast('Sesión de administrador cerrada.');
  });
}

const btnViewAsCatalog = document.getElementById('btn-view-as-catalog');
if (btnViewAsCatalog) {
  btnViewAsCatalog.addEventListener('click', () => {
    isCatalogMode = true;
    closeModal('modal-admin-login');
    updateAuthUI();
    renderAll();
    showToast('Vista previa de cliente activa');
  });
}

const footerAdminLink = document.getElementById('footer-admin-link');
if (footerAdminLink) {
  footerAdminLink.addEventListener('click', () => {
    if (isCatalogMode) {
      // Salir de modo catálogo o abrir login
      if (currentAdminEmail) {
        isCatalogMode = false;
        isAdmin = true;
        updateAuthUI();
        renderAll();
        showToast('Modo Administrador activado');
      } else {
        openAdminAuthModal();
      }
    } else {
      openAdminAuthModal();
    }
  });
}

const btnShareCatalogTopbar = document.getElementById('btn-share-catalog-topbar');
if (btnShareCatalogTopbar) btnShareCatalogTopbar.addEventListener('click', openShareCatalogModal);

/* ========================= SISTEMA DE NOTIFICACIONES Y ALERTAS ========================= */

let currentNotifFilter = 'all';
let lastTriggeredNotifIds = new Set();

function calculateNotifications() {
  const alerts = [];
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  state.rentals.forEach((r) => {
    if (r.status !== 'active') return;

    const danceTitle = r.danceCustom || r.danceName || 'Vestuario general';
    const clientName = r.client || 'Cliente';

    // 1. Alertas de Devolución
    if (r.dateReturn) {
      if (r.dateReturn < todayStr) {
        alerts.push({
          id: `overdue-${r.id}`,
          rentalId: r.id,
          type: 'overdue',
          priority: 'urgent',
          category: 'overdue',
          title: `Devolución Atrasada · ${clientName}`,
          dance: danceTitle,
          client: clientName,
          timeLabel: `Venció el ${formatDateFriendly(r.dateReturn)}`,
          desc: `Los trajes de ${danceTitle} debían devolverse el ${formatDateFriendly(r.dateReturn)}. Comunícate con el cliente o registra la devolución.`,
          badgeText: '⚠️ Atrasado',
          badgeClass: 'danger',
          dateSort: new Date(`${r.dateReturn}T00:00:00`).getTime(),
          actionType: 'return'
        });
      } else if (r.dateReturn === todayStr) {
        alerts.push({
          id: `today-return-${r.id}`,
          rentalId: r.id,
          type: 'today_return',
          priority: 'today',
          category: 'today',
          title: `Devolución Programada para HOY · ${clientName}`,
          dance: danceTitle,
          client: clientName,
          timeLabel: `Hoy ${formatDateFriendly(r.dateReturn)}`,
          desc: `Recepción y chequeo de vestuarios de ${danceTitle} entregados a ${clientName}.`,
          badgeText: '🔄 Hoy Devolución',
          badgeClass: 'warning',
          dateSort: new Date(`${r.dateReturn}T00:00:00`).getTime(),
          actionType: 'return'
        });
      } else if (r.dateReturn === tomorrowStr) {
        alerts.push({
          id: `tomorrow-return-${r.id}`,
          rentalId: r.id,
          type: 'tomorrow_return',
          priority: 'upcoming',
          category: 'upcoming',
          title: `Devolución MAÑANA · ${clientName}`,
          dance: danceTitle,
          client: clientName,
          timeLabel: `Mañana ${formatDateFriendly(r.dateReturn)}`,
          desc: `Recordatorio: mañana vence el alquiler de vestuarios de ${danceTitle}.`,
          badgeText: '📅 Mañana',
          badgeClass: 'info',
          dateSort: new Date(`${r.dateReturn}T00:00:00`).getTime(),
          actionType: 'view'
        });
      }
    }

    // 2. Alertas de Entrega / Salida
    if (r.dateOut) {
      if (r.dateOut === todayStr) {
        alerts.push({
          id: `today-out-${r.id}`,
          rentalId: r.id,
          type: 'today_out',
          priority: 'today',
          category: 'today',
          title: `Entrega Programada para HOY · ${clientName}`,
          dance: danceTitle,
          client: clientName,
          timeLabel: `Hoy ${formatDateFriendly(r.dateOut)}`,
          desc: `Alistar y entregar los trajes de ${danceTitle} a ${clientName}.`,
          badgeText: '📦 Hoy Entrega',
          badgeClass: 'info',
          dateSort: new Date(`${r.dateOut}T00:00:00`).getTime(),
          actionType: 'view'
        });
      } else if (r.dateOut === tomorrowStr) {
        alerts.push({
          id: `tomorrow-out-${r.id}`,
          rentalId: r.id,
          type: 'tomorrow_out',
          priority: 'upcoming',
          category: 'upcoming',
          title: `Entrega MAÑANA · ${clientName}`,
          dance: danceTitle,
          client: clientName,
          timeLabel: `Mañana ${formatDateFriendly(r.dateOut)}`,
          desc: `Preparar y embalar el vestuario de ${danceTitle} para entrega a ${clientName}.`,
          badgeText: '📦 Mañana Salida',
          badgeClass: 'info',
          dateSort: new Date(`${r.dateOut}T00:00:00`).getTime(),
          actionType: 'view'
        });
      }
    }
  });

  return alerts.sort((a, b) => {
    const pOrder = { urgent: 1, today: 2, upcoming: 3 };
    if (pOrder[a.priority] !== pOrder[b.priority]) {
      return pOrder[a.priority] - pOrder[b.priority];
    }
    return a.dateSort - b.dateSort;
  });
}

function updateNotificationsUI() {
  const alerts = calculateNotifications();
  const urgentCount = alerts.filter((a) => a.priority === 'urgent' || a.priority === 'today').length;
  const totalCount = alerts.length;

  // 1. Badge en la barra superior
  const badge = document.getElementById('notifications-badge');
  if (badge) {
    if (urgentCount > 0) {
      badge.textContent = urgentCount > 99 ? '99+' : urgentCount;
      badge.classList.remove('hidden');
    } else if (totalCount > 0) {
      badge.textContent = totalCount;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // 2. Banner de alertas en Alquileres
  const banner = document.getElementById('rental-alerts-banner');
  const bannerText = document.getElementById('rental-alerts-text');
  if (banner && bannerText) {
    const overdueCount = alerts.filter((a) => a.category === 'overdue').length;
    const todayCount = alerts.filter((a) => a.category === 'today').length;

    if (overdueCount > 0 || todayCount > 0) {
      let parts = [];
      if (overdueCount > 0) parts.push(`<strong>${overdueCount} devolución(es) atrasada(s)</strong>`);
      if (todayCount > 0) parts.push(`<strong>${todayCount} evento(s) con horario para hoy</strong>`);
      bannerText.innerHTML = `Atención: Hay ${parts.join(' y ')}.`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  }

  // 3. Si el modal de notificaciones está abierto, actualizar su contenido
  const modalNotifs = document.getElementById('modal-notifications');
  if (modalNotifs && !modalNotifs.classList.contains('hidden')) {
    renderNotificationsList(currentNotifFilter);
  }
}

function renderNotificationsList(filter = 'all') {
  currentNotifFilter = filter;
  const listEl = document.getElementById('notifications-list');
  const emptyEl = document.getElementById('notifications-empty');
  if (!listEl) return;

  const allAlerts = calculateNotifications();
  let filtered = allAlerts;
  if (filter === 'overdue') {
    filtered = allAlerts.filter((a) => a.category === 'overdue');
  } else if (filter === 'today') {
    filtered = allAlerts.filter((a) => a.category === 'today');
  } else if (filter === 'upcoming') {
    filtered = allAlerts.filter((a) => a.category === 'upcoming');
  }

  // Actualizar filtros activos
  document.querySelectorAll('[data-notif-filter]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.notifFilter === filter);
  });

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.classList.remove('hidden');
    return;
  }

  if (emptyEl) emptyEl.classList.add('hidden');

  listEl.innerHTML = filtered.map((item) => {
    let actionBtnHtml = '';
    if (item.actionType === 'return') {
      actionBtnHtml = `
        <button class="btn-primary btn-notif-action" data-notif-action="return" data-rental-id="${item.rentalId}" style="background:var(--accent); color:#FFF; border:none;">
          ✓ Marcar devuelto
        </button>
      `;
    }

    return `
      <div class="notif-card ${item.priority}">
        <div class="notif-card-header">
          <span class="notif-badge-pill ${item.badgeClass}">${escapeHtml(item.badgeText)}</span>
          <span class="notif-card-time">${escapeHtml(item.timeLabel)}</span>
        </div>
        <div class="notif-card-body">
          <div class="notif-card-title">${escapeHtml(item.title)}</div>
          <div class="notif-card-desc">${escapeHtml(item.desc)}</div>
        </div>
        <div class="notif-card-footer">
          <button class="btn-notif-action" data-notif-action="edit" data-rental-id="${item.rentalId}">
            Ver / Editar alquiler
          </button>
          ${actionBtnHtml}
        </div>
      </div>
    `;
  }).join('');

  // Listeners de acciones en las notificaciones
  listEl.querySelectorAll('[data-notif-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.notifAction;
      const rentalId = btn.dataset.rentalId;
      closeModal('modal-notifications');

      // Ir a la pestaña de alquileres
      switchView('alquileres');

      if (action === 'return') {
        const r = state.rentals.find((x) => x.id === rentalId);
        if (r) {
          r.status = 'returned';
          saveState();
          renderRentals();
          renderAvailabilityPanel();
          showToast('Alquiler marcado como devuelto');
        }
      } else if (action === 'edit') {
        openRentalModal(rentalId);
      }
    });
  });
}

function openNotificationsModal() {
  updateNotificationPermissionUI();
  renderNotificationsList(currentNotifFilter);
  openModal('modal-notifications');
}

function updateNotificationPermissionUI() {
  const permBox = document.getElementById('notification-permission-prompt');
  if (!permBox) return;

  if ('Notification' in window) {
    if (Notification.permission === 'granted') {
      permBox.classList.add('hidden');
    } else {
      permBox.classList.remove('hidden');
    }
  } else {
    permBox.classList.add('hidden');
  }
}

async function requestNotificationPermission() {
  if (!('Notification' in window)) {
    showToast('Tu navegador no soporta notificaciones de escritorio.');
    return;
  }

  try {
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      showToast('¡Notificaciones del sistema activadas!');
      updateNotificationPermissionUI();
      checkAndTriggerNotifications(true);
    } else {
      showToast('Permiso de notificaciones rechazado o bloqueado.');
    }
  } catch (e) {
    console.error(e);
  }
}

function checkAndTriggerNotifications(forceNotify = false) {
  updateNotificationsUI();

  if (!('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  const alerts = calculateNotifications();
  const urgentAlerts = alerts.filter((a) => a.priority === 'urgent' || a.priority === 'today');

  urgentAlerts.forEach((alert) => {
    if (forceNotify || !lastTriggeredNotifIds.has(alert.id)) {
      try {
        new Notification(`YAWAR INKA: ${alert.title}`, {
          body: `${alert.timeLabel}\n${alert.desc}`,
          icon: '/favicon.ico'
        });
        lastTriggeredNotifIds.add(alert.id);
      } catch (e) {
        console.log('Error lanzando notification:', e);
      }
    }
  });
}

// Botones de notificaciones
const btnOpenNotifications = document.getElementById('btn-open-notifications');
if (btnOpenNotifications) btnOpenNotifications.addEventListener('click', openNotificationsModal);

const btnOpenNotifsBanner = document.getElementById('btn-open-notifications-banner');
if (btnOpenNotifsBanner) btnOpenNotifsBanner.addEventListener('click', openNotificationsModal);

const btnReqPerm = document.getElementById('btn-request-notification-permission');
if (btnReqPerm) btnReqPerm.addEventListener('click', requestNotificationPermission);

document.querySelectorAll('[data-notif-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    renderNotificationsList(btn.dataset.notifFilter);
  });
});

// Event listeners para controles de Productos (inventario)
const inputSearchProducts = document.getElementById('search-productos');
if (inputSearchProducts) inputSearchProducts.addEventListener('input', () => renderProducts());

const selectFilterDance = document.getElementById('filter-product-dance');
if (selectFilterDance) selectFilterDance.addEventListener('change', () => renderProducts());

const inputSearchDances = document.getElementById('search-danzas');
if (inputSearchDances) inputSearchDances.addEventListener('input', () => renderDances());

const inputSearchRentals = document.getElementById('search-alquileres');
if (inputSearchRentals) inputSearchRentals.addEventListener('input', () => renderRentals());

const selectFilterRentalStatus = document.getElementById('filter-rental-status');
if (selectFilterRentalStatus) selectFilterRentalStatus.addEventListener('change', () => renderRentals());

// Revisión periódica de notificaciones cada minuto
setInterval(() => {
  checkAndTriggerNotifications();
}, 60000);

/* ========================= SINCRONIZACIÓN FIREBASE FIRESTORE ========================= */

function updateSyncStatus(status, label) {
  const pill = document.getElementById('cloud-sync-status');
  if (pill) {
    pill.className = `cloud-sync-pill ${status}`;
    const textSpan = pill.querySelector('.sync-text');
    if (textSpan) textSpan.textContent = label;
  }
}

async function initFirestoreSync() {
  // Si se abre por doble clic en Windows (file://), mantenemos todo en localStorage local sin errores
  if (window.location.protocol === 'file:') {
    console.info('YAWAR INKA: Modo local activo (file://). Para activar la sincronización en la nube con Firestore, abre la carpeta en Visual Studio Code con "Live Server" o súbela a GitHub Pages.');
    updateSyncStatus('synced', 'Modo local');
    return;
  }

  updateSyncStatus('syncing', 'Conectando nube...');

  try {
    const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js');
    const {
      getFirestore,
      collection,
      doc,
      setDoc,
      deleteDoc,
      onSnapshot,
      writeBatch
    } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');

    const firebaseConfig = {
      projectId: "centering-element-q5fd2",
      appId: "1:993272291793:web:c45b7e764b7451666500f0",
      apiKey: "AIzaSyAjeJtUnzxU3G0C007s6Xlif3XALUedCqM",
      authDomain: "centering-element-q5fd2.firebaseapp.com",
      firestoreDatabaseId: "ai-studio-yawarinka-2c802d65-a9cb-4c06-b5dd-89be44d8f590",
      storageBucket: "centering-element-q5fd2.firebasestorage.app",
      messagingSenderId: "993272291793",
      measurementId: "",
      oAuthClientId: "993272291793-tv2f8mpk1oto0csr3csppnippae78nto.apps.googleusercontent.com"
    };

    const app = initializeApp(firebaseConfig);
    db = firebaseConfig.firestoreDatabaseId
      ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
      : getFirestore(app);
    isFirebaseAvailable = true;

    let isInitialLoadDone = false;
    let initialProductsLoaded = false;
    let initialDancesLoaded = false;
    let initialRentalsLoaded = false;

    const checkInitialMigration = async () => {
      if (initialProductsLoaded && initialDancesLoaded && initialRentalsLoaded && !isInitialLoadDone) {
        isInitialLoadDone = true;

        const isFirestoreEmpty =
          state.products.length === 0 &&
          state.dances.length === 0 &&
          state.rentals.length === 0;

        if (isFirestoreEmpty) {
          const savedRaw = localStorage.getItem(STORAGE_KEY);
          if (savedRaw) {
            try {
              const parsed = JSON.parse(savedRaw);
              if (
                (parsed.products && parsed.products.length > 0) ||
                (parsed.dances && parsed.dances.length > 0) ||
                (parsed.rentals && parsed.rentals.length > 0)
              ) {
                updateSyncStatus('syncing', 'Guardando en la nube...');
                await pushFullStateToFirestore(parsed);
              }
            } catch (e) {}
          }
        }
        updateSyncStatus('synced', 'Nube sincronizada');
      }
    };

    // 1. Escuchar colección de Prendas en tiempo real
    onSnapshot(collection(db, 'products'), (snapshot) => {
      const remoteProducts = [];
      snapshot.forEach((docSnap) => {
        remoteProducts.push({ ...docSnap.data(), id: docSnap.id });
      });

      if (isInitialLoadDone || snapshot.size > 0) {
        isRemoteUpdate = true;
        state.products = remoteProducts;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderAll();
        isRemoteUpdate = false;
      }

      initialProductsLoaded = true;
      checkInitialMigration();
      updateSyncStatus('synced', 'Nube sincronizada');
    }, (err) => {
      console.warn('Advertencia snapshot products:', err);
      updateSyncStatus('synced', 'Modo local');
    });

    // 2. Escuchar colección de Danzas en tiempo real
    onSnapshot(collection(db, 'dances'), (snapshot) => {
      const remoteDances = [];
      snapshot.forEach((docSnap) => {
        remoteDances.push({ ...docSnap.data(), id: docSnap.id });
      });

      if (isInitialLoadDone || snapshot.size > 0) {
        isRemoteUpdate = true;
        state.dances = remoteDances;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderAll();
        isRemoteUpdate = false;
      }

      initialDancesLoaded = true;
      checkInitialMigration();
      updateSyncStatus('synced', 'Nube sincronizada');
    }, (err) => {
      console.warn('Advertencia snapshot dances:', err);
      updateSyncStatus('synced', 'Modo local');
    });

    // 3. Escuchar colección de Alquileres en tiempo real
    onSnapshot(collection(db, 'rentals'), (snapshot) => {
      const remoteRentals = [];
      snapshot.forEach((docSnap) => {
        remoteRentals.push({ ...docSnap.data(), id: docSnap.id });
      });

      if (isInitialLoadDone || snapshot.size > 0) {
        isRemoteUpdate = true;
        state.rentals = remoteRentals;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderAll();
        isRemoteUpdate = false;
      }

      initialRentalsLoaded = true;
      checkInitialMigration();
      updateSyncStatus('synced', 'Nube sincronizada');
    }, (err) => {
      console.warn('Advertencia snapshot rentals:', err);
      updateSyncStatus('synced', 'Modo local');
    });

  } catch (err) {
    console.warn('No se pudo inicializar Firebase en este entorno:', err);
    updateSyncStatus('synced', 'Modo local');
  }
}

async function saveProductToFirestore(product) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    updateSyncStatus('syncing', 'Guardando...');
    const docRef = doc(db, 'products', product.id);
    await setDoc(docRef, { ...product, updatedAt: new Date().toISOString() }, { merge: true });
    updateSyncStatus('synced', 'Nube sincronizada');
  } catch (e) {
    console.warn('Error al guardar producto en Firestore:', e);
  }
}

async function deleteProductFromFirestore(productId) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    const { doc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    updateSyncStatus('syncing', 'Eliminando...');
    await deleteDoc(doc(db, 'products', productId));
    updateSyncStatus('synced', 'Nube sincronizada');
  } catch (e) {
    console.warn('Error al eliminar producto en Firestore:', e);
  }
}

async function saveDanceToFirestore(dance) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    updateSyncStatus('syncing', 'Guardando...');
    const docRef = doc(db, 'dances', dance.id);
    await setDoc(docRef, { ...dance, updatedAt: new Date().toISOString() }, { merge: true });
    updateSyncStatus('synced', 'Nube sincronizada');
  } catch (e) {
    console.warn('Error al guardar danza en Firestore:', e);
  }
}

async function deleteDanceFromFirestore(danceId) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    const { doc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    updateSyncStatus('syncing', 'Eliminando...');
    await deleteDoc(doc(db, 'dances', danceId));
    updateSyncStatus('synced', 'Nube sincronizada');
  } catch (e) {
    console.warn('Error al eliminar danza en Firestore:', e);
  }
}

async function saveRentalToFirestore(rental) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    const { doc, setDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    updateSyncStatus('syncing', 'Guardando...');
    const docRef = doc(db, 'rentals', rental.id);
    await setDoc(docRef, { ...rental, updatedAt: new Date().toISOString() }, { merge: true });
    updateSyncStatus('synced', 'Nube sincronizada');
  } catch (e) {
    console.warn('Error al guardar alquiler en Firestore:', e);
  }
}

async function deleteRentalFromFirestore(rentalId) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    const { doc, deleteDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    updateSyncStatus('syncing', 'Eliminando...');
    await deleteDoc(doc(db, 'rentals', rentalId));
    updateSyncStatus('synced', 'Nube sincronizada');
  } catch (e) {
    console.warn('Error al eliminar alquiler en Firestore:', e);
  }
}

async function pushFullStateToFirestore(fullState) {
  if (!isFirebaseAvailable || !db) return;
  try {
    const { doc, writeBatch } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    updateSyncStatus('syncing', 'Sincronizando...');
    const batch = writeBatch(db);

    if (Array.isArray(fullState.products)) {
      fullState.products.forEach((p) => {
        batch.set(doc(db, 'products', p.id), { ...p, updatedAt: new Date().toISOString() }, { merge: true });
      });
    }

    if (Array.isArray(fullState.dances)) {
      fullState.dances.forEach((d) => {
        batch.set(doc(db, 'dances', d.id), { ...d, updatedAt: new Date().toISOString() }, { merge: true });
      });
    }

    if (Array.isArray(fullState.rentals)) {
      fullState.rentals.forEach((r) => {
        batch.set(doc(db, 'rentals', r.id), { ...r, updatedAt: new Date().toISOString() }, { merge: true });
      });
    }

    await batch.commit();
    updateSyncStatus('synced', 'Nube sincronizada');
  } catch (e) {
    console.warn('Error al sincronizar lote:', e);
  }
}

/* ========================= INICIALIZACIÓN ========================= */

function renderAll() {
  updateAuthUI();
  renderProducts();
  renderDances();
  renderRentals();
  renderAvailabilityPanel();
}

// 1. Render inicial inmediato de la interfaz (desde almacenamiento local)
renderAll();

// 2. Iniciar conexión a Firebase Firestore en segundo plano
initFirestoreSync();

