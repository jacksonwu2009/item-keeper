import { TabStack } from '../../../components/TabStack';

/** 「设备」标签：iOS 上外面包一层系统导航栏、标题用大标题；安卓、网页直接显示页面。见 TabStack */
export default function DevicesLayout() {
  return <TabStack route="devices" />;
}
