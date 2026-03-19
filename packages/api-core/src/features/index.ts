// Feature manager types removed — ServiceFeature, FeatureContext, ALL_SERVICE_FEATURES
// were defined but never consumed. Service-level features (billing, email, oauth)
// are resolved at runtime via the /config endpoint and useFeatures() in the frontend.
