// Feature configuration for administrative control of app features
export type FeatureKey = 'webChat' | 'all'
export type FeatureConfig = Partial<Record<FeatureKey, boolean>>