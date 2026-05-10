import { Routes } from '@angular/router';

// Two-page app. List → Detail. The simulator panel lives on the list page
// rather than its own route because users need to see segments shift in
// reaction to the actions they trigger from the panel.
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'segments',
  },
  {
    path: 'segments',
    loadComponent: () =>
      import('./segments/segments-list.page').then((m) => m.SegmentsListPage),
  },
  {
    path: 'segments/:id',
    loadComponent: () =>
      import('./segments/segment-detail.page').then((m) => m.SegmentDetailPage),
  },
  { path: '**', redirectTo: 'segments' },
];
