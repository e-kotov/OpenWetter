plugins { id("com.android.application") }

android {
    namespace = "io.github.ekotov.openwetter"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.ekotov.openwetter"
        minSdk = 26
        targetSdk = 35
        versionCode = 4
        versionName = "0.1.0-alpha.4"
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }

    // Share exactly the same app shell between the browser PWA and Android app.
    sourceSets.getByName("main").assets.srcDir("../../web")
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
