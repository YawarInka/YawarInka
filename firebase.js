// Firebase SDK con URLs CDN oficiales compatibles con navegador directo (VS Code, GitHub Pages, Vite)
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore,
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// Configuración directa de Firebase (sin dependencias de JSON externo)
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

let app = null;
let db = null;
let isFirebaseAvailable = false;

try {
  app = initializeApp(firebaseConfig);
  db = firebaseConfig.firestoreDatabaseId
    ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
    : getFirestore(app);
  isFirebaseAvailable = true;
} catch (err) {
  console.warn('Firebase no se pudo inicializar en este entorno (ej. file://):', err);
}

export { db };

let isInitialLoadDone = false;
let isRemoteUpdate = false;
let onSyncStateChangeCallback = null;

export function setSyncStatusCallback(cb) {
  onSyncStateChangeCallback = cb;
}

function updateStatus(status, label) {
  if (onSyncStateChangeCallback) {
    onSyncStateChangeCallback(status, label);
  }
}

/**
 * Inicia la sincronización en tiempo real con Firestore
 */
export function initFirestoreSync(localState, onStateUpdated) {
  if (!isFirebaseAvailable || !db) {
    console.info('Firebase Firestore no disponible en este protocolo/entorno. Usando almacenamiento local.');
    updateStatus('synced', 'Modo local');
    return () => {};
  }

  updateStatus('syncing', 'Conectando nube...');

  let initialProductsLoaded = false;
  let initialDancesLoaded = false;
  let initialRentalsLoaded = false;

  const checkInitialMigration = async () => {
    if (initialProductsLoaded && initialDancesLoaded && initialRentalsLoaded && !isInitialLoadDone) {
      isInitialLoadDone = true;

      // Si Firestore está completamente vacío pero hay datos locales, migrar a Firestore
      const isFirestoreEmpty =
        localState.products.length === 0 &&
        localState.dances.length === 0 &&
        localState.rentals.length === 0;

      if (isFirestoreEmpty) {
        // Cargar desde localStorage inicial si existía
        const savedRaw = localStorage.getItem('yawar_inka_inventario_v3');
        if (savedRaw) {
          try {
            const parsed = JSON.parse(savedRaw);
            if (
              (parsed.products && parsed.products.length > 0) ||
              (parsed.dances && parsed.dances.length > 0) ||
              (parsed.rentals && parsed.rentals.length > 0)
            ) {
              console.log('Migrando datos locales existentes a Firebase Firestore...');
              updateStatus('syncing', 'Guardando en la nube...');
              await pushFullStateToFirestore(parsed);
            }
          } catch (e) {
            console.error('Error al parsear estado local para migración:', e);
          }
        }
      }

      updateStatus('synced', 'Nube sincronizada');
    }
  };

  try {
    // 1. Escuchar colección de Prendas / Productos en tiempo real
    const unsubProducts = onSnapshot(
      collection(db, 'products'),
      (snapshot) => {
        const remoteProducts = [];
        snapshot.forEach((docSnap) => {
          remoteProducts.push({ ...docSnap.data(), id: docSnap.id });
        });

        if (isInitialLoadDone || snapshot.size > 0) {
          isRemoteUpdate = true;
          localState.products = remoteProducts;
          localStorage.setItem('yawar_inka_inventario_v3', JSON.stringify(localState));
          onStateUpdated();
          isRemoteUpdate = false;
        }

        initialProductsLoaded = true;
        checkInitialMigration();
        updateStatus('synced', 'Nube sincronizada');
      },
      (err) => {
        console.warn('Snapshot products advertencia:', err);
        updateStatus('synced', 'Modo local');
      }
    );

    // 2. Escuchar colección de Danzas en tiempo real
    const unsubDances = onSnapshot(
      collection(db, 'dances'),
      (snapshot) => {
        const remoteDances = [];
        snapshot.forEach((docSnap) => {
          remoteDances.push({ ...docSnap.data(), id: docSnap.id });
        });

        if (isInitialLoadDone || snapshot.size > 0) {
          isRemoteUpdate = true;
          localState.dances = remoteDances;
          localStorage.setItem('yawar_inka_inventario_v3', JSON.stringify(localState));
          onStateUpdated();
          isRemoteUpdate = false;
        }

        initialDancesLoaded = true;
        checkInitialMigration();
        updateStatus('synced', 'Nube sincronizada');
      },
      (err) => {
        console.warn('Snapshot dances advertencia:', err);
        updateStatus('synced', 'Modo local');
      }
    );

    // 3. Escuchar colección de Alquileres en tiempo real
    const unsubRentals = onSnapshot(
      collection(db, 'rentals'),
      (snapshot) => {
        const remoteRentals = [];
        snapshot.forEach((docSnap) => {
          remoteRentals.push({ ...docSnap.data(), id: docSnap.id });
        });

        if (isInitialLoadDone || snapshot.size > 0) {
          isRemoteUpdate = true;
          localState.rentals = remoteRentals;
          localStorage.setItem('yawar_inka_inventario_v3', JSON.stringify(localState));
          onStateUpdated();
          isRemoteUpdate = false;
        }

        initialRentalsLoaded = true;
        checkInitialMigration();
        updateStatus('synced', 'Nube sincronizada');
      },
      (err) => {
        console.warn('Snapshot rentals advertencia:', err);
        updateStatus('synced', 'Modo local');
      }
    );

    return () => {
      unsubProducts();
      unsubDances();
      unsubRentals();
    };
  } catch (err) {
    console.warn('Error inicializando listeners Firestore:', err);
    updateStatus('synced', 'Modo local');
    return () => {};
  }
}

/**
 * Guarda o actualiza un producto individual en Firestore
 */
export async function saveProductToFirestore(product) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    updateStatus('syncing', 'Guardando...');
    const docRef = doc(db, 'products', product.id);
    await setDoc(docRef, { ...product, updatedAt: new Date().toISOString() }, { merge: true });
    updateStatus('synced', 'Guardado en la nube');
  } catch (e) {
    console.warn('Firestore no disponible al guardar producto, mantenido localmente:', e);
    updateStatus('synced', 'Guardado local');
  }
}

/**
 * Elimina un producto de Firestore
 */
export async function deleteProductFromFirestore(productId) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    updateStatus('syncing', 'Eliminando...');
    await deleteDoc(doc(db, 'products', productId));
    updateStatus('synced', 'Guardado en la nube');
  } catch (e) {
    console.warn('Firestore no disponible al eliminar producto:', e);
  }
}

/**
 * Guarda o actualiza una danza individual en Firestore
 */
export async function saveDanceToFirestore(dance) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    updateStatus('syncing', 'Guardando...');
    const docRef = doc(db, 'dances', dance.id);
    await setDoc(docRef, { ...dance, updatedAt: new Date().toISOString() }, { merge: true });
    updateStatus('synced', 'Guardado en la nube');
  } catch (e) {
    console.warn('Firestore no disponible al guardar danza:', e);
    updateStatus('synced', 'Guardado local');
  }
}

/**
 * Elimina una danza de Firestore
 */
export async function deleteDanceFromFirestore(danceId) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    updateStatus('syncing', 'Eliminando...');
    await deleteDoc(doc(db, 'dances', danceId));
    updateStatus('synced', 'Guardado en la nube');
  } catch (e) {
    console.warn('Firestore no disponible al eliminar danza:', e);
  }
}

/**
 * Guarda o actualiza un alquiler individual en Firestore
 */
export async function saveRentalToFirestore(rental) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    updateStatus('syncing', 'Guardando...');
    const docRef = doc(db, 'rentals', rental.id);
    await setDoc(docRef, { ...rental, updatedAt: new Date().toISOString() }, { merge: true });
    updateStatus('synced', 'Guardado en la nube');
  } catch (e) {
    console.warn('Firestore no disponible al guardar alquiler:', e);
    updateStatus('synced', 'Guardado local');
  }
}

/**
 * Elimina un alquiler de Firestore
 */
export async function deleteRentalFromFirestore(rentalId) {
  if (!isFirebaseAvailable || !db || isRemoteUpdate) return;
  try {
    updateStatus('syncing', 'Eliminando...');
    await deleteDoc(doc(db, 'rentals', rentalId));
    updateStatus('synced', 'Guardado en la nube');
  } catch (e) {
    console.warn('Firestore no disponible al eliminar alquiler:', e);
  }
}

/**
 * Sube todo el estado completo a Firestore (migración o restauración)
 */
export async function pushFullStateToFirestore(fullState) {
  if (!isFirebaseAvailable || !db) return;
  try {
    updateStatus('syncing', 'Sincronizando...');
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
    updateStatus('synced', 'Nube sincronizada');
  } catch (e) {
    console.warn('Error sincronizando lote con Firestore:', e);
    updateStatus('synced', 'Modo local');
  }
}
