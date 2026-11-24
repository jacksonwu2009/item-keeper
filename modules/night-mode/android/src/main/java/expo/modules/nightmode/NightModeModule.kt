package expo.modules.nightmode

import android.app.UiModeManager
import android.content.Context
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * 把 App 里选的颜色模式告诉安卓系统并让系统记住（JS 接口见 modules/night-mode/index.ts）。
 *
 * 为什么要它：开屏是系统在 App 的代码跑起来之前画的，用浅色底还是深色底看的是系统记着的这个 App 的深浅色。
 * 不告诉系统的话，系统是浅色、App 里选了深色时，每次启动都是先一屏浅色的开屏再变深色。
 * 安卓 12（API 31）起才有这个接口；更早的系统什么也不做，开屏跟着系统走。
 */
class NightModeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("NightMode")

    // mode：dark / light，别的都当跟随系统。返回系统支不支持
    Function("setNightMode") { mode: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@Function false
      val context = appContext.reactContext ?: return@Function false
      val manager = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager ?: return@Function false
      manager.setApplicationNightMode(
        when (mode) {
          "dark" -> UiModeManager.MODE_NIGHT_YES
          "light" -> UiModeManager.MODE_NIGHT_NO
          else -> UiModeManager.MODE_NIGHT_AUTO
        }
      )
      true
    }
  }
}
