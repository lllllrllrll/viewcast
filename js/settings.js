import {firebaseConfig, firebaseConfigured} from "./firebase-config.js";
import {initializeAccountDeletion} from "./modules/settings-account-deletion.js?v=2";
import {initializeSettingsPreferences} from "./modules/settings-preferences.js?v=1";

initializeSettingsPreferences();
initializeAccountDeletion({firebaseConfig, firebaseConfigured});
