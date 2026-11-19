export interface ModeBadgeOptions { compact?: boolean }
export interface IslandOptions { className?: string; label?: string }
export interface ListRowOptions {
  title?: string; subtitle?: string; value?: string; icon?: string;
  action?: string; disabled?: boolean;
}
export interface ActionTileOptions {
  label?: string; icon?: string; action?: string; disabled?: boolean; reason?: string;
}
export interface PnlChipOptions { positive?: boolean | null; label?: string }
export interface EmptyStateOptions {
  title?: string; description?: string; action?: string; actionLabel?: string;
}
export interface SkeletonOptions { rows?: number; className?: string }
export interface SegmentedItem { value?: string; label?: string }
export interface SegmentedOptions { label?: string }
export type ButtonVariant = "primary" | "long" | "short" | "ghost" | "destructive";
export interface ButtonOptions {
  label?: string; action?: string; variant?: ButtonVariant; disabled?: boolean; reason?: string;
}
export declare function modeBadgeMarkup(mode: string, options?: ModeBadgeOptions): string;
export declare function islandMarkup(content: string, options?: IslandOptions): string;
export declare function listRowMarkup(options?: ListRowOptions): string;
export declare function actionTileMarkup(options?: ActionTileOptions): string;
export declare function pnlChipMarkup(value: string | number | null | undefined, options?: PnlChipOptions): string;
export declare function emptyStateMarkup(options?: EmptyStateOptions): string;
export declare function skeletonMarkup(options?: SkeletonOptions): string;
export declare function segmentedMarkup(items: SegmentedItem[], active: string, options?: SegmentedOptions): string;
export declare function buttonMarkup(options?: ButtonOptions): string;
export declare const KGDesign: Readonly<{
  modeBadgeMarkup: typeof modeBadgeMarkup;
  islandMarkup: typeof islandMarkup;
  listRowMarkup: typeof listRowMarkup;
  actionTileMarkup: typeof actionTileMarkup;
  pnlChipMarkup: typeof pnlChipMarkup;
  emptyStateMarkup: typeof emptyStateMarkup;
  skeletonMarkup: typeof skeletonMarkup;
  segmentedMarkup: typeof segmentedMarkup;
  buttonMarkup: typeof buttonMarkup;
}>;
