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
  label?: string; action?: string; variant?: string; disabled?: boolean; reason?: string;
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

export interface SettingsRowOptions extends ListRowOptions { iconColor?: string }
export interface SparklineOptions { positive?: boolean | null; label?: string }
export interface GlassPillOptions { label?: string; action?: string; icon?: string; disabled?: boolean }
export interface RoundIconButtonOptions { label?: string; icon?: string; action?: string; disabled?: boolean }
export interface HeatmapTileOptions { symbol?: string; changePct?: number | null; volume?: number | null; action?: string }
export interface BottomSheetOptions { title?: string; open?: boolean; labelledBy?: string }
export interface FloatingTabItem { value?: string; action?: string; label?: string; icon?: string }
export interface FloatingTabOptions { label?: string }
export interface ToastOptions { variant?: "info" | "success" | "error" | string }
export interface ErrorBannerOptions { action?: string; actionLabel?: string }
export declare function settingsRowMarkup(options?: SettingsRowOptions): string;
export declare function sparklineMarkup(points: number[], options?: SparklineOptions): string;
export declare function glassPillMarkup(options?: GlassPillOptions): string;
export declare function roundIconButtonMarkup(options?: RoundIconButtonOptions): string;
export declare function heatmapTileMarkup(options?: HeatmapTileOptions): string;
export declare function bottomSheetMarkup(content: string, options?: BottomSheetOptions): string;
export declare function floatingTabBarMarkup(items: FloatingTabItem[], active: string, options?: FloatingTabOptions): string;
export declare function toastMarkup(message: string, options?: ToastOptions): string;
export declare function errorBannerMarkup(message: string, options?: ErrorBannerOptions): string;

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
