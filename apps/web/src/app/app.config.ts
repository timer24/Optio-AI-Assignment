import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';

// Application-level providers.
//   - provideHttpClient: enables HttpClient injection app-wide.
//   - withComponentInputBinding: lets route-param components receive the
//     `id` segment as an @Input() instead of injecting ActivatedRoute.
export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    provideRouter(routes, withComponentInputBinding()),
  ],
};
