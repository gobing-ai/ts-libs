export {
    BrowserAutomationError,
    BrowserProfileBusyError,
    BrowserProfileMissingError,
    InvalidProfileDirError,
    LoginTimeoutError,
    OperationAbortedError,
    PlaywrightUnavailableError,
} from './errors';
export type { BrowserLauncher, PersistentLauncherOptions, ProfileLaunchRequest } from './launcher';
export type {
    IsAuthenticatedPredicate,
    LoginWithProfileOptions,
    OpenPersistentBrowserOptions,
    ProfilePageHandle,
    WithProfilePageOptions,
} from './operations';
export { loginWithProfile, openPersistentBrowser, withProfilePage } from './operations';
