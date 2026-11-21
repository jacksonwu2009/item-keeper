import { TabStack } from '../../../components/TabStack';

/** 「设置」标签：iOS 上外面包一层系统导航栏、标题用大标题，右上角不放办公点切换；安卓、网页直接显示页面。见 TabStack */
export default function SettingsLayout() {
  return <TabStack route="settings" withOffice={false} />;
}
