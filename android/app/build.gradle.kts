import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.jetbrains.kotlin.android)
  alias(libs.plugins.compose.compiler)
}

val localProperties =
    Properties().apply {
      val file = rootDir.resolve("local.properties")
      if (file.exists()) file.inputStream().use { load(it) }
    }

android {
  namespace = "com.memorylane.glasses"
  compileSdk = 36

  buildFeatures {
    buildConfig = true
    compose = true
  }

  defaultConfig {
    applicationId = "com.memorylane.glasses"
    minSdk = 31
    targetSdk = 36
    versionCode = 1
    versionName = "0.1"

    // Developer Mode uses "0" for both. Real credentials come from the Wearables Developer Center.
    manifestPlaceholders["mwdat_application_id"] =
        localProperties.getProperty("mwdat_application_id", "0")
    manifestPlaceholders["mwdat_client_token"] =
        localProperties.getProperty("mwdat_client_token", "0")
    // Where the Memory Lane server lives. 127.0.0.1 works over USB with
    // `adb reverse tcp:8787 tcp:8787`, which avoids depending on venue Wi-Fi.
    buildConfigField(
        "String",
        "DEFAULT_SERVER_URL",
        "\"${localProperties.getProperty("memorylane_server_url", "http://127.0.0.1:8787")}\"",
    )
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }

  packaging { resources { excludes += "/META-INF/{AL2.0,LGPL2.1}" } }
}

kotlin { compilerOptions { jvmTarget = JvmTarget.JVM_17 } }

dependencies {
  implementation(libs.androidx.activity.compose)
  implementation(platform(libs.androidx.compose.bom))
  implementation(libs.androidx.lifecycle.runtime.compose)
  implementation(libs.androidx.lifecycle.viewmodel.compose)
  implementation(libs.androidx.material3)
  implementation(libs.androidx.material.icons.extended)
  implementation(libs.mwdat.core)
  implementation(libs.mwdat.camera)
  implementation(libs.mwdat.display)
  implementation(libs.mwdat.speech)
  implementation(libs.mwdat.motion)
  implementation(libs.mwdat.inputs)
  testImplementation("junit:junit:4.13.2")
  // The Android jar's org.json is an empty shell in unit tests.
  testImplementation("org.json:json:20240303")
  implementation(libs.mwdat.mockdevice)
}
