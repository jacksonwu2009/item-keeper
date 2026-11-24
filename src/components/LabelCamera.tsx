import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions, type CameraCapturedPicture } from 'expo-camera';
import { File, Paths } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, Linking, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from './Text';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { prepareLabelOcrAsync, recognizeLabelAsync, type OcrLine } from '../../modules/label-ocr';
import { formatDate, todayStr, type ShelfLife } from '../lib/dates';
import { decideDates, matchesShelfLife, parseLabel, type DateDecision, type DateRole, type LabelParseResult } from '../lib/labelParse';
import {
  dateScanProblem,
  describeShelfCheck,
  frameToCrop,
  labelScanProblem,
  type DateScanResult,
  type LabelScanResult,
  type NormalizedRect,
  type Rect,
  type ScanProblem,
  type Size,
} from '../lib/labelScan';
import { makeStyles, useColors } from '../hooks/useTheme';
import { cameraColors, CONTENT_MAX_WIDTH, font, radius } from '../theme';
import { CircleIconButton } from './CircleIconButton';
import { Button } from './ui';

export type { DateScanResult, LabelScanResult };

type Props =
  | {
      mode: 'date';
      /** 点的是哪一格旁边的「拍日期」 */
      target: DateRole;
      /** 商品资料里或正在填的保质期，用来和喷码上的两个日期互相印证 */
      shelfLife: ShelfLife | null;
      onDone: (result: DateScanResult) => void;
      onClose: () => void;
    }
  | { mode: 'label'; onDone: (result: LabelScanResult) => void; onClose: () => void };

type Shot = { uri: string; crop: NormalizedRect | null; size: Size };

type Phase =
  | { kind: 'camera' }
  | { kind: 'working' }
  | { kind: 'problem'; problem: ScanProblem }
  | { kind: 'choose'; decision: DateDecision; shot: Shot; shelfLife: ShelfLife | null; target: DateRole };

/** 模型加载过一次以后就不用再提示「第一次要等一会儿」 */
let modelLoaded = false;

/** 只删 App 自己缓存目录里的临时照片（相机拍的、从相册选时复制出来的），不会碰相册里的原图 */
function deleteTempPhoto(uri: string) {
  try {
    if (!uri.startsWith(Paths.cache.uri)) return;
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // 删不掉也不影响使用：在缓存目录里，系统会清
  }
}

/**
 * 拍照识别的相机（全屏）。两种用法：
 * - mode=date：入库「拍日期」。小取景框只框喷码；认出一个日期就直接交回去，认出几个就在这里列出来点选。
 * - mode=label：新增物品「拍包装」。先拍背面标签；标签上没有日期（常写「见瓶盖」）时接着拍喷码，可以跳过。
 * 都能从相册选。照片只在手机上识别，识别完就删掉临时文件，不上传、不进备份。
 * 拍得不好（糊、暗、反光，或者什么都没认出来）时提示重拍。
 */
export function LabelCamera(props: Props) {
  const colors = useColors();
  const cameraStyles = useCameraStyles();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [step, setStep] = useState<'label' | 'date'>(props.mode === 'label' ? 'label' : 'date');
  const [phase, setPhase] = useState<Phase>({ kind: 'camera' });
  const [labelResult, setLabelResult] = useState<LabelParseResult | null>(null);
  const [torch, setTorch] = useState(false);
  const [view, setView] = useState<Size | null>(null);
  const [frame, setFrame] = useState<Rect | null>(null);
  const [selected, setSelected] = useState(0);
  const tempFiles = useRef<string[]>([]);

  useEffect(() => {
    prepareLabelOcrAsync()
      .then(() => {
        modelLoaded = true;
      })
      .catch(() => undefined);
    const files = tempFiles.current;
    return () => files.splice(0).forEach(deleteTempPhoto);
  }, []);

  function discardTemp() {
    // 原地清空（不换数组）：卸载时的清理拿的是同一个数组
    tempFiles.current.splice(0).forEach(deleteTempPhoto);
  }

  function finishDate(result: DateScanResult) {
    discardTemp();
    if (props.mode === 'date') props.onDone(result);
    else if (labelResult) props.onDone({ label: labelResult, dates: result });
  }

  function finishLabel(label: LabelParseResult, dates: DateScanResult | null) {
    discardTemp();
    if (props.mode === 'label') props.onDone({ label, dates });
  }

  function close() {
    discardTemp();
    props.onClose();
  }

  async function handleShot(shot: Shot) {
    setPhase({ kind: 'working' });
    let lines: OcrLine[];
    try {
      lines = (await recognizeLabelAsync(shot.uri, { crop: shot.crop })).lines;
      modelLoaded = true;
    } catch (error) {
      discardTemp();
      const message = error instanceof Error ? error.message : String(error);
      setPhase({ kind: 'problem', problem: { title: '识别出错了，请再拍一次', tips: [message] } });
      return;
    }
    const today = todayStr();
    const parsed = parseLabel(lines, today);

    if (step === 'label') {
      const problem = labelScanProblem(parsed);
      if (problem) {
        discardTemp();
        setPhase({ kind: 'problem', problem });
        return;
      }
      setLabelResult(parsed);
      const decision = decideDates(parsed.dates, { shelfLife: parsed.shelfLife, today, target: 'production' });
      if (decision.options.length) {
        setSelected(Math.max(0, decision.suggested));
        setPhase({ kind: 'choose', decision, shot, shelfLife: parsed.shelfLife, target: 'production' });
        return;
      }
      if (decision.production || decision.expiry) {
        finishLabel(parsed, { production: decision.production, expiry: decision.expiry, confirmed: decision.confirmed });
        return;
      }
      // 标签上没有日期（常写「见瓶盖」「见包装喷码处」）：接着拍喷码
      discardTemp();
      setStep('date');
      setPhase({ kind: 'camera' });
      return;
    }

    const problem = dateScanProblem(parsed);
    if (problem) {
      discardTemp();
      setPhase({ kind: 'problem', problem });
      return;
    }
    const shelfLife = props.mode === 'date' ? props.shelfLife : (labelResult?.shelfLife ?? parsed.shelfLife);
    const target: DateRole = props.mode === 'date' ? props.target : 'production';
    const decision = decideDates(parsed.dates, { shelfLife, today, target });
    if (decision.options.length) {
      setSelected(Math.max(0, decision.suggested));
      setPhase({ kind: 'choose', decision, shot, shelfLife, target });
      return;
    }
    finishDate({ production: decision.production, expiry: decision.expiry, confirmed: decision.confirmed });
  }

  async function shoot() {
    if (!camera.current || phase.kind !== 'camera') return;
    setPhase({ kind: 'working' });
    let photo: CameraCapturedPicture;
    try {
      photo = await camera.current.takePictureAsync({ quality: 0.92, shutterSound: false });
    } catch {
      setPhase({ kind: 'problem', problem: { title: '没拍成，请再拍一次', tips: [] } });
      return;
    }
    tempFiles.current.push(photo.uri);
    const size = { width: photo.width, height: photo.height };
    const crop = view && frame ? frameToCrop(view, frame, size) : null;
    await handleShot({ uri: photo.uri, crop, size });
  }

  async function pickFromAlbum() {
    if (phase.kind === 'working') return;
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 });
    if (result.canceled || !result.assets?.length) return;
    const asset = result.assets[0];
    tempFiles.current.push(asset.uri);
    await handleShot({ uri: asset.uri, crop: null, size: { width: asset.width, height: asset.height } });
  }

  function acceptChoice() {
    if (phase.kind !== 'choose') return;
    const options = phase.decision.options;
    const picked = options[selected]?.date;
    if (!picked) return;
    const others = options.filter((_option, index) => index !== selected).map((option) => option.date);
    const shelfLife = phase.shelfLife;
    if (phase.target === 'production') {
      const expiry = shelfLife ? others.find((other) => other > picked && matchesShelfLife(picked, other, shelfLife)) : undefined;
      finishDate({ production: picked, expiry: expiry ?? null, confirmed: !!expiry });
    } else {
      const production = shelfLife ? others.find((other) => other < picked && matchesShelfLife(other, picked, shelfLife)) : undefined;
      finishDate({ production: production ?? null, expiry: picked, confirmed: !!production });
    }
  }

  function retake() {
    discardTemp();
    setPhase({ kind: 'camera' });
  }

  function skipDate() {
    if (labelResult) finishLabel(labelResult, null);
  }

  // 安卓返回键：选日期、提示重拍时回到相机，相机里关掉
  function back() {
    if (phase.kind === 'choose' || phase.kind === 'problem') retake();
    else if (phase.kind === 'camera') close();
  }

  const dateStep = step === 'date';
  const tip = dateStep
    ? props.mode === 'label'
      ? labelResult?.dateElsewhere
        ? `标签上写「${labelResult.dateElsewhere}」：接着拍日期喷码`
        : '接着拍日期喷码（瓶盖、封口、袋边上印的）'
      : '只框住日期喷码，靠近一点、别反光'
    : '对准背面的产品标签，文字清楚、别反光';

  const header = (
    <View style={[cameraStyles.header, { top: insets.top + 8, left: insets.left + 16, right: insets.right + 16 }]}>
      <CircleIconButton icon="close" label="关闭拍照识别" onPress={close} />
      {props.mode === 'label' ? (
        <View style={cameraStyles.steps}>
          <StepPill index={1} text="背面标签" active={!dateStep} />
          <StepPill index={2} text="日期喷码" active={dateStep} />
        </View>
      ) : null}
      <View style={cameraStyles.headerSpacer} />
    </View>
  );

  let body;
  if (!permission) {
    body = <View style={cameraStyles.dark}>{header}</View>;
  } else if (!permission.granted) {
    // 没有相机权限：和扫码页一样浅色底一张白卡片；还能从相册选
    body = (
      <View style={[cameraStyles.light, { paddingTop: insets.top + 64, paddingBottom: insets.bottom + 16 }]}>
        {header}
        <View style={cameraStyles.permissionCard}>
          <Ionicons name="camera-outline" size={56} color={colors.accent} />
          <Text style={cameraStyles.permissionTitle}>需要相机权限才能拍照识别</Text>
          <Text style={cameraStyles.permissionText}>照片只在手机上识别，识别完就删掉，不会上传。</Text>
          {permission.canAskAgain ? (
            <Button title="允许使用相机" onPress={() => requestPermission()} style={cameraStyles.permissionButton} />
          ) : (
            <Button title="去系统设置开启" onPress={() => Linking.openSettings()} style={cameraStyles.permissionButton} />
          )}
          <Button title="从相册选" variant="secondary" icon="images-outline" onPress={pickFromAlbum} style={cameraStyles.permissionButton} />
        </View>
        {resultLayer()}
      </View>
    );
  } else {
    body = (
      <View style={cameraStyles.dark} onLayout={(event) => setView(event.nativeEvent.layout)}>
        <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="back" enableTorch={torch} />
        <View style={cameraStyles.overlay} pointerEvents="none">
          <Text style={cameraStyles.tip}>{tip}</Text>
          <View
            style={[cameraStyles.frame, dateStep ? cameraStyles.frameDate : cameraStyles.frameLabel]}
            onLayout={(event) => setFrame(event.nativeEvent.layout)}
          />
          <Text style={cameraStyles.subTip}>
            {dateStep ? '日期常在瓶盖、封口、袋子边上，是一排小点组成的字' : '照片只在手机上识别，识别完就删掉'}
          </Text>
        </View>
        {header}
        <View style={[cameraStyles.bottom, { paddingBottom: insets.bottom + 24 }]}>
          <RoundAction icon="images-outline" label="相册" accessibilityLabel="从相册选" onPress={pickFromAlbum} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="拍照"
            onPress={shoot}
            style={({ pressed }) => [cameraStyles.shutter, pressed && cameraStyles.pressed]}
          >
            <View style={cameraStyles.shutterInner} />
          </Pressable>
          {props.mode === 'label' && dateStep ? (
            <RoundAction icon="play-skip-forward-outline" label="跳过" accessibilityLabel="跳过拍日期" onPress={skipDate} />
          ) : (
            <RoundAction
              icon={torch ? 'flashlight' : 'flashlight-outline'}
              label="补光"
              accessibilityLabel={torch ? '关闭补光' : '打开补光'}
              onPress={() => setTorch((value) => !value)}
            />
          )}
        </View>
        {resultLayer()}
      </View>
    );
  }

  // 相机上面盖的一层：识别中 / 提示重拍 / 选日期
  function resultLayer() {
    if (phase.kind === 'working') {
      return (
        <View style={cameraStyles.working}>
          <ActivityIndicator size="large" color={cameraColors.ink} />
          <Text style={cameraStyles.workingText}>正在识别…</Text>
          {!modelLoaded ? <Text style={cameraStyles.workingSub}>第一次要加载识别模型，稍等几秒</Text> : null}
        </View>
      );
    }
    if (phase.kind === 'problem') {
      return (
        <View style={cameraStyles.dim}>
          <View style={[cameraStyles.panel, { paddingBottom: insets.bottom + 16 }]}>
            <View style={cameraStyles.problemHead}>
              <Ionicons name="alert-circle" size={22} color={colors.warn} />
              <Text style={cameraStyles.panelTitle}>{phase.problem.title}</Text>
            </View>
            {phase.problem.tips.map((item) => (
              <Text key={item} style={cameraStyles.problemTip}>
                · {item}
              </Text>
            ))}
            <View style={cameraStyles.panelActions}>
              {props.mode === 'label' && step === 'date' ? (
                <Button title="跳过" variant="ghost" onPress={skipDate} style={cameraStyles.flex} />
              ) : (
                <Button title={props.mode === 'label' ? '不用了，手动填' : '手动选'} variant="ghost" onPress={close} style={cameraStyles.flex} />
              )}
              <Button title="重拍" onPress={retake} style={cameraStyles.flex} />
            </View>
          </View>
        </View>
      );
    }
    if (phase.kind === 'choose') {
      const options = phase.decision.options;
      const picked = options[selected]?.date ?? null;
      const check =
        picked && phase.target === 'production'
          ? describeShelfCheck(
              picked,
              phase.shelfLife,
              options.filter((_option, index) => index !== selected).map((option) => option.date),
            )
          : null;
      return (
        <View style={cameraStyles.dim}>
          <View style={[cameraStyles.panel, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={cameraStyles.panelTitle}>
              认出 {options.length} 个日期，选{phase.target === 'production' ? '生产日期' : '到期日'}
            </Text>
            <CropPreview shot={phase.shot} />
            <ScrollView style={cameraStyles.optionList} contentContainerStyle={cameraStyles.optionListContent}>
              {options.map((option, index) => {
                const active = index === selected;
                return (
                  <Pressable
                    key={option.date}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: active }}
                    accessibilityLabel={formatDate(option.date)}
                    onPress={() => setSelected(index)}
                    style={[cameraStyles.option, active && cameraStyles.optionActive]}
                  >
                    <Ionicons
                      name={active ? 'radio-button-on' : 'radio-button-off'}
                      size={22}
                      color={active ? colors.accent : colors.faint}
                    />
                    <View style={cameraStyles.flex}>
                      <Text style={cameraStyles.optionDate}>{formatDate(option.date)}</Text>
                      {option.note ? <Text style={cameraStyles.optionNote}>{option.note}</Text> : null}
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
            {check ? <Text style={cameraStyles.check}>{check}</Text> : null}
            <View style={cameraStyles.panelActions}>
              <Button title="重拍" variant="ghost" onPress={retake} style={cameraStyles.flex} />
              <Button title="用这个" onPress={acceptChoice} style={cameraStyles.flex} />
            </View>
          </View>
        </View>
      );
    }
    return null;
  }

  return (
    <Modal visible animationType="slide" onRequestClose={back} statusBarTranslucent navigationBarTranslucent>
      {body}
    </Modal>
  );
}

function StepPill({ index, text, active }: { index: number; text: string; active: boolean }) {
  const cameraStyles = useCameraStyles();
  return (
    <View style={[cameraStyles.stepPill, active && cameraStyles.stepPillActive]}>
      <Text style={[cameraStyles.stepText, active && cameraStyles.stepTextActive]}>
        {index === 1 ? '①' : '②'} {text}
      </Text>
    </View>
  );
}

function RoundAction({
  icon,
  label,
  accessibilityLabel,
  onPress,
}: {
  icon: 'images-outline' | 'flashlight' | 'flashlight-outline' | 'play-skip-forward-outline';
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const cameraStyles = useCameraStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [cameraStyles.roundAction, pressed && cameraStyles.pressed]}
    >
      <View style={cameraStyles.roundIcon}>
        <Ionicons name={icon} size={24} color={cameraColors.ink} />
      </View>
      <Text style={cameraStyles.roundLabel}>{label}</Text>
    </Pressable>
  );
}

/** 选日期时上面放拍到的那一小块，一眼能对照 */
function CropPreview({ shot }: { shot: Shot }) {
  const cameraStyles = useCameraStyles();
  const [width, setWidth] = useState(0);
  // 相机拍的按竖的算（有的手机返回的宽高没按方向转）；相册里的照片宽高是摆正过的
  const portrait = shot.crop !== null;
  const photoWidth = portrait ? Math.min(shot.size.width, shot.size.height) : shot.size.width;
  const photoHeight = portrait ? Math.max(shot.size.width, shot.size.height) : shot.size.height;
  const crop = shot.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const cropWidth = Math.max(1, crop.width * photoWidth);
  const cropHeight = Math.max(1, crop.height * photoHeight);
  const height = width ? Math.min(140, Math.max(56, (width * cropHeight) / cropWidth)) : 80;
  const scale = width ? Math.min(width / cropWidth, height / cropHeight) : 0;
  return (
    <View style={[cameraStyles.cropBox, { height }]} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {scale ? (
        <Image
          source={{ uri: shot.uri }}
          accessibilityLabel="拍到的日期"
          style={{
            position: 'absolute',
            width: photoWidth * scale,
            height: photoHeight * scale,
            left: (width - cropWidth * scale) / 2 - crop.x * photoWidth * scale,
            top: (height - cropHeight * scale) / 2 - crop.y * photoHeight * scale,
          }}
        />
      ) : null}
    </View>
  );
}

// 相机画面上的东西照扫码页：白色取景框和提示字，浅灰圆形的关闭；下面三个按钮照效果图（相册、快门、补光）。
// 结果面板是白色底部面板（和别处的面板一样上面两个大圆角）
const useCameraStyles = makeStyles((colors) => ({
  flex: { flex: 1 },
  dark: { flex: 1, backgroundColor: cameraColors.bg },
  light: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: 16, alignItems: 'center' },
  header: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerSpacer: { width: 40 },
  steps: { flex: 1, flexDirection: 'row', justifyContent: 'center', gap: 8 },
  // 画面很亮（白墙、白标签）时也看得清：没选中的是深色半透明底白字
  stepPill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: radius.pill, backgroundColor: 'rgba(0,0,0,0.5)' },
  stepPillActive: { backgroundColor: cameraColors.ink },
  stepText: { color: 'rgba(255,255,255,0.85)', fontSize: font.small, fontWeight: '500' },
  stepTextActive: { color: cameraColors.inkOnWhite, fontWeight: '600' },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 120,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  // 提示字压在深色半透明胶囊上，画面亮的时候也看得清
  tip: {
    color: cameraColors.ink,
    fontSize: font.heading,
    fontWeight: '500',
    textAlign: 'center',
    marginHorizontal: 24,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  subTip: {
    color: cameraColors.ink,
    fontSize: font.small,
    textAlign: 'center',
    marginHorizontal: 32,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  frame: { borderWidth: 3, borderColor: cameraColors.ink, borderRadius: radius.lg },
  // 拍日期：只框喷码的一小条
  frameDate: { width: '84%', maxWidth: 360, aspectRatio: 3.2 },
  // 拍标签：竖着的一大块
  frameLabel: { width: '86%', maxWidth: 420, aspectRatio: 0.9 },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingTop: 16,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  shutter: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: cameraColors.ink },
  pressed: { opacity: 0.6 },
  roundAction: { alignItems: 'center', gap: 6, width: 72 },
  roundIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundLabel: { color: cameraColors.ink, fontSize: font.small },
  working: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  workingText: { color: cameraColors.ink, fontSize: font.heading, fontWeight: '500' },
  workingSub: { color: cameraColors.inkSoft, fontSize: font.small },
  dim: { position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0, backgroundColor: 'rgba(16, 24, 20, 0.45)', justifyContent: 'flex-end' },
  panel: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignSelf: 'center',
    maxHeight: '80%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    padding: 16,
    paddingTop: 20,
    gap: 12,
  },
  panelTitle: { flexShrink: 1, fontSize: font.title - 4, fontWeight: '700', color: colors.ink },
  problemHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  problemTip: { fontSize: font.body, color: colors.muted, lineHeight: 22 },
  panelActions: { flexDirection: 'row', gap: 12, marginTop: 4 },
  cropBox: { width: '100%', borderRadius: radius.md, overflow: 'hidden', backgroundColor: '#2B2B28' },
  optionList: { flexGrow: 0 },
  optionListContent: { gap: 8 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.surfaceSunken,
    backgroundColor: colors.surfaceSunken,
  },
  optionActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  optionDate: { fontSize: font.heading, fontWeight: '600', color: colors.ink },
  optionNote: { fontSize: font.small, color: colors.muted, marginTop: 2 },
  check: { fontSize: font.small, color: colors.accent, fontWeight: '600', lineHeight: 20 },
  permissionCard: {
    width: '100%',
    maxWidth: CONTENT_MAX_WIDTH,
    alignItems: 'center',
    gap: 12,
    padding: 24,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
  },
  permissionTitle: { color: colors.ink, fontSize: font.heading, fontWeight: '500', textAlign: 'center' },
  permissionText: { color: colors.muted, fontSize: font.small, lineHeight: 20, textAlign: 'center' },
  permissionButton: { marginTop: 4, alignSelf: 'stretch' },
}));
