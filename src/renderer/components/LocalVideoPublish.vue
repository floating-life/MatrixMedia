<template>
  <div>
    <el-dialog
      title="填写发布内容"
      :close-on-click-modal="false"
      :visible.sync="metaVisible"
      :close-on-press-escape="false"
      width="800px"
      @close="handleMetaClose"
    >
      <!-- 选视频行：小方块缩略图 + 文件名同行；方块/行内可直接拖入替换，
           点击方块预览播放，点「替换」弹系统文件框（#72） -->
      <div
        class="file-field-row"
        @dragover.prevent
        @drop.prevent="onFileLineDrop"
      >
        <div
          class="file-thumb"
          :title="localFilePath ? '点击预览播放' : '点击选择或拖入视频文件'"
          @click="localFilePath ? (previewVisible = true) : reselectVideoFile()"
        >
          <video
            v-if="localFilePath"
            :src="localFileUrl"
            class="file-thumb-video"
            muted
            preload="metadata"
          />
          <i v-else class="el-icon-upload" />
        </div>
        <div class="file-meta">
          <div class="file-name">
            <template v-if="localFilePath">
              <strong>已选文件：</strong>{{ displayFileName }}
            </template>
            <template v-else>点击选择或拖入视频文件</template>
          </div>
          <div class="file-tip" v-if="!localFilePath">
            支持 mp4 / mov / mkv / avi / webm / m4v，选中后自动填入名称
          </div>
          <div class="file-actions" v-else>
            <el-button type="text" size="mini" @click="reselectVideoFile"
              >替换</el-button
            >
            <el-button
              type="text"
              size="mini"
              @click="previewVisible = true"
              >预览播放</el-button
            >
          </div>
        </div>
      </div>

      <!-- 视频预览播放 -->
      <el-dialog
        title="视频预览"
        :visible.sync="previewVisible"
        width="640px"
        append-to-body
      >
        <video
          v-if="previewVisible && localFilePath"
          :src="localFileUrl"
          controls
          autoplay
          style="width: 100%; max-height: 70vh; background: #000"
        />
      </el-dialog>
      <el-form label-width="88px" class="meta-form">
        <el-form-item label="名称">
          <el-input
            v-model="form.title"
            placeholder="默认与视频文件名一致，可改"
          />
        </el-form-item>
        <el-form-item label="视频标题">
          <div class="ai-field-row">
            <el-input v-model="form.bt1" placeholder="发布时使用的标题" />
            <ai-generate-button
              :active="metaVisible"
              kind="title"
              :get-context="getAiContext"
              @generated="onAiTitle"
            />
          </div>
        </el-form-item>
        <el-form-item label="视频简介">
          <div class="ai-field-row">
            <el-input
              v-model="form.description"
              type="textarea"
              :rows="4"
              maxlength="2000"
              show-word-limit
              placeholder="选填，将作为各平台正文或简介"
            />
            <ai-generate-button
              :active="metaVisible"
              kind="body"
              :get-context="getAiContext"
              @generated="onAiBody"
            />
          </div>
        </el-form-item>
        <el-form-item label="视频标签">
          <div class="ai-field-row">
            <el-select
              ref="bqSelect"
              v-model="bqTags"
              multiple
              filterable
              allow-create
              default-first-option
              no-data-text="请输入标签"
              placeholder="输入标签，回车/空格添加；支持批量粘贴 #标签1 #标签2"
              style="width: 100%"
              @paste.native.capture="onBqPaste"
              @compositionstart.native.capture="onBqCompositionStart"
              @compositionend.native.capture="onBqCompositionEnd"
              @keydown.native.capture="onBqKeydown"
            ></el-select>
            <ai-generate-button
              :active="metaVisible"
              kind="tags"
              :get-context="getAiContext"
              @generated="onAiTags"
            />
          </div>
        </el-form-item>
        <el-form-item label="视频号短标题">
          <el-input
            ref="bt2Input"
            v-model="form.shortTitle"
            placeholder="仅视频号使用，选填，建议 6～16 字"
            @input="onBt2Input"
            @keydown.native.capture="onBt2Keydown"
          />
          <p class="bt2-tip">
            <strong>微信视频号</strong
            >会将本项用于「概括视频主要内容」，填写时长度需为 6～16
            字，且不能包含特殊标点符号。
          </p>
        </el-form-item>
        <el-form-item label="分平台标题">
          <div class="platform-title-grid">
            <div
              v-for="item in platformTitleOverrideList"
              :key="item.pt"
              class="platform-title-item"
            >
              <span class="platform-title-label"
                >{{ item.pt }}<small v-if="item.hint">（{{ item.hint }}）</small></span
              >
              <el-input
                :value="getPlatformTitleOverride(item.pt)"
                size="small"
                clearable
                :placeholder="`留空使用通用标题`"
                @input="setPlatformTitleOverride(item.pt, $event)"
              />
            </div>
          </div>
          <p class="bt2-tip">
            选填。填写后优先覆盖该平台的通用标题；超出平台字数上限时仍会自动按标点兜底截断。
          </p>
        </el-form-item>
        <el-form-item label="封面图片">
          <div class="cover-field-row">
            <el-button size="small" @click="chooseCoverImage">{{
              form.coverPath ? "重新选择封面" : "选择封面图片"
            }}</el-button>
            <el-button
              v-if="form.coverPath"
              type="text"
              size="small"
              class="cover-clear"
              @click="form.coverPath = ''"
              >清除</el-button
            >
            <span v-if="form.coverPath" class="cover-name" :title="form.coverPath">{{
              coverFileName
            }}</span>
          </div>
          <p class="bt2-tip">
            选填（竖版 3:4 最佳）。设置后抖音 / 快手 / 视频号会使用自定义封面（视频号仅支持
            jpg/png），不选则由平台自动截取视频帧。
          </p>
        </el-form-item>
        <el-form-item label="横版封面(4:3)">
          <div class="cover-field-row">
            <el-button size="small" @click="chooseCoverHImage">{{
              form.coverPathH ? "重新选择横版封面" : "选择横版封面(4:3)"
            }}</el-button>
            <el-button
              v-if="form.coverPathH"
              type="text"
              size="small"
              class="cover-clear"
              @click="form.coverPathH = ''"
              >清除</el-button
            >
            <span
              v-if="form.coverPathH"
              class="cover-name"
              :title="form.coverPathH"
              >{{ coverHFileName }}</span
            >
          </div>
          <p class="bt2-tip">
            选填（仅抖音 / 视频号生效）。指定后将居中裁切为 1440×1080（4:3）；留空但已选竖版封面时，自动由竖封面居中并两侧模糊补边生成 4:3 横版封面（视频号仅支持 jpg/png）。
          </p>
        </el-form-item>
        <el-alert
          v-if="metaRuleWarnings.length"
          type="warning"
          :closable="false"
          show-icon
          class="rule-precheck-alert"
          title="发布前预检：部分平台文案超限，发布时将自动截断 / 裁剪标签（不阻断发布）"
        >
          <div class="rule-precheck-list">
            <div
              v-for="w in metaRuleWarnings"
              :key="w.platform"
              class="rule-precheck-item"
            >
              {{ w.summary }}
            </div>
          </div>
        </el-alert>
        <el-form-item label="定时发布">
          <el-switch
            v-model="scheduledPublish"
            active-text="定时"
            inactive-text="立即"
          />
        </el-form-item>
        <el-form-item v-if="scheduledPublish" label="发布时间">
          <el-date-picker
            v-model="publishAt"
            type="datetime"
            value-format="yyyy-MM-dd HH:mm:ss"
            placeholder="选择年月日时分秒"
            style="width: 260px"
          />
          <p class="bt2-tip">
            定时任务会立即进入发布历史，到点后自动发布；如果程序关闭错过时间，会显示任务过期。
          </p>
        </el-form-item>
      </el-form>
      <div slot="footer" class="dialog-footer">
        <el-button @click="metaVisible = false">取消</el-button>
        <el-button type="primary" @click="onMetaNext">下一步</el-button>
      </div>
    </el-dialog>

    <el-dialog
      title="选择账号并发布"
      :close-on-click-modal="false"
      :visible.sync="platformVisible"
      :close-on-press-escape="false"
      width="800px"
      @close="handlePlatformClose"
    >
      <el-form class="video-form">
        <el-form-item label="是否显示自动化发布过程">
          <el-switch
            v-model="thisShow"
            active-text="显示"
            inactive-text="不显示"
          />
        </el-form-item>
        <el-form-item v-if="thisShow" label="发布完是否关闭窗口">
          <el-switch
            v-model="closeWindow"
            active-text="关闭"
            inactive-text="不关闭"
          />
        </el-form-item>
        <el-form-item label="作品下载权限">
          <el-checkbox v-model="form.noDownload"
            >禁止下载此作品（仅快手生效：取消勾选「允许下载此作品」并校验终态，未确认会中止发布）</el-checkbox
          >
        </el-form-item>
        <el-form-item label="同步发布">
          <el-checkbox
            v-model="form.dySyncToutiao"
            @change="saveDySyncToutiaoPreference"
            >抖音同步发布到今日头条（仅抖音生效）</el-checkbox
          >
        </el-form-item>
      </el-form>

      <el-divider content-position="left">账号平台选择</el-divider>

      <div v-if="treeData.length > 0" class="platform-tree-toolbar">
        <el-checkbox
          :indeterminate="checkAllIndeterminate"
          v-model="checkAllPlatforms"
          @change="handleCheckAllPlatforms"
        >
          全选
        </el-checkbox>
        <span class="batch-statement-wrap">
          <span class="batch-statement-label">批量声明</span>
          <el-select
            v-model="batchCreativeStatement"
            class="batch-statement-select"
            popper-class="statement-select-dropdown"
            size="small"
            placeholder="选择声明"
          >
            <el-option
              v-for="opt in batchStatementOptions"
              :key="opt.value"
              :label="opt.label"
              :value="opt.value"
              @click.native="onBatchStatementOptionClick(opt.value)"
            />
          </el-select>
          <el-button
            type="text"
            size="small"
            :disabled="checkedPlatformNodes.length === 0"
            @click="applyBatchCreativeStatement"
          >
            应用到已勾选
          </el-button>
        </span>
        <span class="batch-collection-wrap">
          <span class="batch-statement-label">合集</span>
          <el-input
            v-model="batchCollection"
            class="batch-collection-input"
            size="small"
            clearable
            placeholder="留空不选（抖音/快手/视频号）"
          />
          <el-button
            type="text"
            size="small"
            :disabled="checkedPlatformNodes.length === 0"
            @click="applyBatchCollection"
          >
            应用到已勾选
          </el-button>
        </span>
      </div>

      <el-tree
        v-if="treeData.length > 0"
        ref="tree"
        :data="treeData"
        node-key="id"
        show-checkbox
        default-expand-all
        :props="defaultProps"
        @check="onTreeCheck"
      >
        <span
          class="custom-tree-node"
          :class="{ 'platform-leaf-node': !!data.url }"
          slot-scope="{ data }"
        >
          <template v-if="!data.url">
            <span>{{ data.title }}</span>
            <el-button
              size="mini"
              type="text"
              style="margin-left: 5px"
              @click.stop="verifyLogin(data)"
              >验证登录</el-button
            >
          </template>
          <template v-else>
            <div class="platform-leaf-main">
              <span class="platform-leaf-name">{{ data.pt }}</span>
              <span
                v-if="data.proxyDisplay"
                class="platform-leaf-proxy"
                :title="'已配置代理 ' + data.proxyDisplay"
              >
                代理 {{ data.proxyDisplay }}
              </span>
              <span
                class="platform-leaf-login"
                :style="{ color: data.loggedIn ? 'green' : 'red' }"
              >
                <span
                  v-if="data.loggedIn"
                  class="login-ok"
                  @click="reLogin(data)"
                  >登录√</span
                >
                <span v-else @click="reLogin(data)">❌重新登录</span>
              </span>
            </div>
            <div
              v-if="
                platformSupportsCreativeStatement(data.pt) &&
                isPlatformNodeChecked(data.id)
              "
              class="platform-statement-row"
            >
              <el-select
                :value="getPlatformStatement(data.id)"
                size="mini"
                class="platform-statement-select"
                popper-class="statement-select-dropdown"
                :title="getPlatformStatementDisplay(data)"
                @input="setPlatformStatement(data.id, $event)"
              >
                <el-option
                  v-for="opt in getStatementOptionsForNode(data)"
                  :key="opt.value"
                  :label="getStatementOptionPlatformLabel(opt, data.pt)"
                  :value="opt.value"
                />
              </el-select>
            </div>
          </template>
        </span>
      </el-tree>
      <el-empty
        v-if="treeData.length === 0"
        description="请先在右上角添加媒体平台账号"
      />

      <el-alert
        v-if="checkedPlatformRuleWarnings.length"
        type="warning"
        :closable="false"
        show-icon
        class="rule-precheck-alert"
        title="发布前预检：已勾选平台将自动截断 / 裁剪标签（不阻断发布）"
      >
        <div class="rule-precheck-list">
          <div
            v-for="(w, idx) in checkedPlatformRuleWarnings.slice(0, 6)"
            :key="w.key || w.platform || idx"
            class="rule-precheck-item"
          >
            {{ w.summary }}
          </div>
          <div
            v-if="checkedPlatformRuleWarnings.length > 6"
            class="rule-precheck-item"
          >
            …等共 {{ checkedPlatformRuleWarnings.length }} 条平台规则调整
          </div>
        </div>
      </el-alert>

      <div slot="footer" class="dialog-footer">
        <el-button :disabled="publishing" @click="goBackToMeta"
          >上一步</el-button
        >
        <el-button :disabled="publishing" @click="platformVisible = false"
          >取消</el-button
        >
        <el-button type="primary" :disabled="publishing" @click="onPlatformNext"
          >下一步</el-button
        >
      </div>

      <!-- 旧的 <webview> 登录弹窗已迁移到主进程的独立 BrowserWindow，
           避免被小红书等站点的 GuestView 指纹识别后反复跳登录。
           现在点击"重新登录"会通过 openLoginWindow 调用 IPC 弹独立窗口。 -->
    </el-dialog>

    <el-dialog
      :title="attrsDialogTitle"
      :close-on-click-modal="false"
      :visible.sync="attrsVisible"
      :close-on-press-escape="false"
      width="920px"
      @close="handleAttrsClose"
    >
      <el-alert
        v-if="checkedPlatformRuleWarnings.length"
        type="warning"
        :closable="false"
        show-icon
        class="rule-precheck-alert"
        title="发布前预检：已勾选平台存在超限项，发布时将自动截断 / 裁剪标签（不阻断发布）"
      >
        <div class="rule-precheck-list">
          <div
            v-for="(w, idx) in checkedPlatformRuleWarnings.slice(0, 8)"
            :key="w.key || w.platform || idx"
            class="rule-precheck-item"
          >
            {{ w.summary }}
          </div>
          <div
            v-if="checkedPlatformRuleWarnings.length > 8"
            class="rule-precheck-item"
          >
            …等共 {{ checkedPlatformRuleWarnings.length }} 条平台规则调整
          </div>
        </div>
      </el-alert>

      <p v-if="!attrsHasSph" class="bt2-tip">
        当前未勾选视频号，无需配置第三方属性，确认后可直接发布。
      </p>
      <el-table
        :data="checkedPlatformNodes"
        border
        size="small"
        style="width: 100%"
      >
        <el-table-column prop="pt" label="平台" width="100" />
        <el-table-column prop="phone" label="账号" min-width="140" />
        <el-table-column
          v-if="!isDirBatchMode"
          label="覆盖标题（可选）"
          min-width="200"
        >
          <template slot-scope="{ row }">
            <div class="attrs-title-cell">
              <el-input
                v-if="platformSupportsTitleOverride(row.pt)"
                :value="getPlatformTitleOverride(row.pt)"
                size="mini"
                clearable
                :placeholder="getPlatformTitleOverridePlaceholder(row.pt)"
                @input="setPlatformTitleOverride(row.pt, $event)"
              />
              <span v-else class="attrs-unsupported">使用短标题/简介</span>
              <el-tag
                v-if="getCheckedPlatformRowWarning(row.pt)"
                size="mini"
                type="warning"
                class="attrs-truncate-tag"
                :title="getCheckedPlatformRowWarning(row.pt)"
                >将截断</el-tag
              >
            </div>
          </template>
        </el-table-column>
        <el-table-column label="第三方属性" min-width="420">
          <template slot-scope="{ row }">
            <div
              v-if="platformSupportsVideoLink(row.pt)"
              class="attrs-link-cell"
            >
              <el-select
                :value="getPlatformVideoLinkType(row.id, row.pt)"
                size="mini"
                class="attrs-link-type"
                @input="onAttrsLinkTypeChange(row, $event)"
              >
                <el-option
                  v-for="opt in getPlatformVideoLinkOptions(row.pt)"
                  :key="opt.type"
                  :label="opt.label"
                  :value="opt.type"
                  :disabled="!opt.automationSupported"
                />
              </el-select>
              <template v-if="platformVideoLinkNeedsValue(row)">
                <template v-if="platformVideoLinkIsProduct(row)">
                  <el-select
                    :value="getPlatformVideoLinkValue(row.id)"
                    size="mini"
                    filterable
                    clearable
                    class="attrs-product-select"
                    placeholder="从橱窗选择商品"
                    :loading="!!platformProductLoading[row.id]"
                    @visible-change="
                      (open) => open && loadPlatformWindowProducts(row)
                    "
                    @input="setPlatformVideoLinkValue(row.id, row.pt, $event)"
                  >
                    <el-option
                      v-for="item in getPlatformProductOptions(row.id)"
                      :key="item.productId"
                      :label="item.title + ' (' + item.productId + ')'"
                      :value="item.productId"
                    />
                  </el-select>
                  <el-button
                    type="text"
                    size="mini"
                    :loading="!!platformProductLoading[row.id]"
                    @click="loadPlatformWindowProducts(row, true)"
                    >刷新橱窗</el-button
                  >
                  <el-input
                    :value="getPlatformVideoLinkValue(row.id)"
                    size="mini"
                    clearable
                    class="attrs-product-id"
                    placeholder="或手动输入商品编号"
                    @input="setPlatformVideoLinkValue(row.id, row.pt, $event)"
                  />
                </template>
                <template v-else-if="platformVideoLinkHasEntityList(row)">
                  <!-- 服务端关键词搜索下拉：
                       · 打开时下拉为空、不请求（没有「首开加载中」）
                       · 输入即带 queryString 请求平台搜索接口（element-ui remote 模式
                         每次输入防抖后调用 remote-method）
                       · 下拉只渲染服务端返回的结果，整体替换不累加
                       · 点选某一项才写入值；回车只触发搜索不选中
                       · 清空（点 × 或删空输入）必须同时清掉下拉结果，
                         否则会残留上一次的候选
                       刻意不设 default-first-option：它的回车会自动选中第一项。
                       刻意不加 allow-create：它会把输入文本变成可选项（下拉里出现输入框）。 -->
                  <el-select
                    :value="getPlatformVideoLinkValue(row.id)"
                    size="mini"
                    filterable
                    remote
                    clearable
                    :remote-method="(q) => searchPlatformEntityOptions(row, q)"
                    :no-data-text="platformEntityNoDataText(row)"
                    class="attrs-product-select"
                    :placeholder="platformVideoLinkSearchPlaceholder(row)"
                    :loading="!!platformEntityLoading[entityOptionsKey(row)]"
                    @visible-change="(open) => handleEntityDropdownToggle(row, open)"
                    @input="onEntityValueChange(row, $event)"
                    @clear="clearPlatformEntityOptions(row)"
                    @keydown.native.enter.prevent="onEntitySearchEnter(row, $event)"
                  >
                    <el-option
                      v-for="item in getPlatformEntityOptions(row)"
                      :key="item.name"
                      :label="item.name"
                      :value="item.name"
                    >
                      <span>{{ item.name }}</span>
                      <span v-if="item.subTitle" class="attrs-entity-sub">{{
                        item.subTitle
                      }}</span>
                    </el-option>
                  </el-select>
                </template>
                <el-input
                  v-else
                  :value="getPlatformVideoLinkValue(row.id)"
                  size="mini"
                  clearable
                  class="attrs-link-value"
                  :maxlength="platformVideoLinkMaxLength(row)"
                  :placeholder="platformVideoLinkPlaceholder(row)"
                  @input="setPlatformVideoLinkValue(row.id, row.pt, $event)"
                />
                <el-input
                  v-if="platformVideoLinkNeedsShortTitle(row)"
                  :value="getPlatformVideoLinkShortTitle(row.id)"
                  size="mini"
                  clearable
                  class="attrs-link-value"
                  placeholder="商品短标题（必填，最多10字）"
                  @input="setPlatformVideoLinkShortTitle(row.id, row.pt, $event)"
                />
              </template>
            </div>
            <span v-else class="attrs-unsupported">暂不支持第三方属性</span>
          </template>
        </el-table-column>
        <el-table-column label="合集（可选）" min-width="170">
          <template slot-scope="{ row }">
            <el-input
              v-if="platformSupportsCollection(row.pt)"
              :value="getPlatformCollection(row.id, row.pt)"
              size="mini"
              clearable
              placeholder="留空不选"
              @input="setPlatformCollection(row.id, $event)"
            />
            <span v-else class="attrs-unsupported">暂不支持</span>
          </template>
        </el-table-column>
      </el-table>

      <p v-if="attrsHasProductLink" class="bt2-tip">
        抖音需填写商品链接和短标题；快手商品须先加入货架，并填写完整原名。商品无法唯一匹配或挂载失败时停止发布，请人工检查后重试。
      </p>
      <p v-if="attrsHasEntityLink" class="bt2-tip">
        挂载失败时不会直接发布：视频处理完成后会自动转存草稿并提示「需要处理」，请到视频号后台手动确认。
      </p>

      <div slot="footer" class="dialog-footer">
        <el-button :disabled="publishing" @click="goBackToPlatform"
          >上一步</el-button
        >
        <el-button :disabled="publishing" @click="attrsVisible = false"
          >取消</el-button
        >
        <el-button
          type="primary"
          :loading="publishing"
          :disabled="publishing"
          @click="handleBatchPublish"
          >发布</el-button
        >
        <el-button
          type="primary"
          :loading="publishing"
          :disabled="publishing"
          @click="handleBatchPublishToDraft"
          >发布到草稿</el-button
        >
      </div>
    </el-dialog>

    <!-- Directory batch publish dialog -->
    <el-dialog
      title="目录批量发布"
      :close-on-click-modal="false"
      :visible.sync="dirPublishVisible"
      :close-on-press-escape="false"
      width="700px"
      @close="handleDirPublishClose"
    >
      <div
        style="
          margin-bottom: 16px;
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          align-items: center;
        "
      >
        <el-button size="small" @click="chooseBatchDir">
          {{ dirPath ? "重新选择目录" : "选择目录" }}
        </el-button>
        <span
          v-if="dirPath"
          style="font-size: 13px; color: #606266; word-break: break-all"
          >{{ dirPath }}</span
        >
      </div>
      <div
        style="
          margin-bottom: 16px;
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          align-items: center;
        "
      >
        <el-button size="small" @click="chooseBatchXlsx">
          {{ dirXlsxRows.length ? "重新选择声明文件" : "选择声明文件 (xlsx)" }}
        </el-button>
        <el-button size="small" type="text" @click="downloadBatchTemplate"
          >下载模版</el-button
        >
        <span v-if="dirXlsxError" style="color: #f56c6c; font-size: 13px">{{
          dirXlsxError
        }}</span>
        <span
          v-else-if="dirXlsxRows.length"
          style="font-size: 13px; color: #67c23a"
          >已加载 {{ dirXlsxRows.length }} 条记录</span
        >
      </div>
      <p class="bt2-tip" style="margin-bottom: 12px">
        声明文件支持列：文件名 / 标题 / 简介 / 标签 / 视频号短标题 / 封面 / 横版封面（选填，抖音与视频号 4:3 封面；路径无效会阻断发布）/ 合集 / 分平台覆盖列（如「抖音标题」「百家号标题」「快手简介」，优先于通用标题/简介）。
      </p>

      <el-table
        v-if="dirXlsxRows.length"
        :data="dirXlsxRows"
        size="mini"
        max-height="260"
        style="width: 100%; margin-bottom: 16px"
      >
        <el-table-column
          prop="fileName"
          label="文件名"
          min-width="160"
          show-overflow-tooltip
        />
        <el-table-column
          prop="title"
          label="标题"
          min-width="160"
          show-overflow-tooltip
        />
        <el-table-column
          prop="description"
          label="简介"
          min-width="160"
          show-overflow-tooltip
        />
        <el-table-column
          prop="tags"
          label="标签"
          min-width="120"
          show-overflow-tooltip
        />
        <el-table-column
          prop="shortTitle"
          label="视频号短标题"
          min-width="140"
          show-overflow-tooltip
        />
        <el-table-column
          prop="coverPath"
          label="封面"
          min-width="120"
          show-overflow-tooltip
        />
        <el-table-column
          prop="coverPathH"
          label="横版封面"
          min-width="120"
          show-overflow-tooltip
        />
        <el-table-column
          label="分平台覆盖"
          min-width="140"
          show-overflow-tooltip
        >
          <template slot-scope="{ row }">
            <span>{{ formatRowPlatformOverrides(row) || "—" }}</span>
          </template>
        </el-table-column>
        <el-table-column
          prop="collection"
          label="合集"
          min-width="120"
          show-overflow-tooltip
        />
        <el-table-column label="文件状态" width="80">
          <template slot-scope="{ row }">
            <span
              :style="{
                color: dirFileExists(row.fileName) ? '#67c23a' : '#f56c6c',
              }"
            >
              {{ dirFileExists(row.fileName) ? "✓" : "✗" }}
            </span>
          </template>
        </el-table-column>
      </el-table>

      <el-form label-width="88px" style="margin-bottom: 8px">
        <el-form-item label="定时发布">
          <el-switch
            v-model="scheduledPublish"
            active-text="定时"
            inactive-text="立即"
          />
        </el-form-item>
        <el-form-item v-if="scheduledPublish" label="发布时间">
          <el-date-picker
            v-model="publishAt"
            type="datetime"
            value-format="yyyy-MM-dd HH:mm:ss"
            placeholder="选择年月日时分秒"
            style="width: 260px"
          />
        </el-form-item>
      </el-form>

      <div slot="footer" class="dialog-footer">
        <el-button @click="dirPublishVisible = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!dirPath || !dirXlsxRows.length"
          @click="onDirPublishNext"
          >下一步</el-button
        >
      </div>
    </el-dialog>

    <!-- 发布节流排期预览表（点击「发布」前确认或改为不节流） -->
    <el-dialog
      title="发布排期预览（发布节流 / 平台错峰）"
      :visible.sync="throttlePreviewVisible"
      width="840px"
      append-to-body
      :close-on-click-modal="false"
      @close="onThrottlePreviewDialogClose"
    >
      <p class="bt2-tip" style="margin-top: 0; margin-bottom: 12px">
        以下为根据当前节流规则（同账号最小间隔、允许发布时段、每日上限与平台错峰延迟）计算的计划发布时间；确认后将自动提交立即任务并创建定时任务，或可点击「改为不节流」绕过本次节流。
      </p>
      <el-table
        :data="throttlePreviewRows"
        border
        size="small"
        max-height="360"
        style="width: 100%"
      >
        <el-table-column prop="pt" label="平台" width="100" />
        <el-table-column
          prop="phone"
          label="账号"
          min-width="130"
          show-overflow-tooltip
        />
        <el-table-column
          prop="title"
          label="标题"
          min-width="160"
          show-overflow-tooltip
        />
        <el-table-column label="计划时间" width="185">
          <template slot-scope="{ row }">
            <el-tag
              size="mini"
              :type="
                row.isDraft
                  ? 'info'
                  : row.scheduled
                  ? 'warning'
                  : 'success'
              "
            >
              {{ row.plannedTimeText }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column
          prop="reasonText"
          label="原因"
          min-width="210"
          show-overflow-tooltip
        />
      </el-table>
      <div slot="footer" class="dialog-footer">
        <el-button @click="resolveThrottlePreview('cancel')">取消</el-button>
        <el-button
          type="warning"
          plain
          @click="resolveThrottlePreview('no_throttle')"
        >
          {{
            throttlePreviewHasExplicitTime
              ? "改为不节流（按原定时间）"
              : "改为不节流（全部立即发布）"
          }}
        </el-button>
        <el-button
          type="primary"
          @click="resolveThrottlePreview('confirm')"
        >
          确认按排期发布
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script>
import { ipcRenderer } from "electron";
import moment from "moment";
import dataRequest from "@/utils/dataRequest";
import ptConfig from "@/utils/configUrl";
import openLoginWindow from "@/utils/openLoginWindow";
import {
  setAccountLoginFlag,
  clearAccountLoginFlag,
  isAccountLoginFlagSet,
} from "@/utils/accountLoginFlag";
import {
  CREATIVE_STATEMENT_DEFAULT,
  DEFAULT_PUBLISH_CREATIVE_STATEMENT,
  CREATIVE_STATEMENT_OPTIONS,
  getCreativeStatementOptionsForPlatform,
  getCreativeStatementPlatformKey,
  getCreativeStatementShortLabel,
  normalizeCreativeStatement,
  platformSupportsCreativeStatement,
  resolveCreativeStatementForPlatform,
} from "../../shared/creativeStatement.js";
import {
  getAccountProxyDisplay,
  isAccountProxyEnabled,
} from "../../shared/accountProxy.js";
import {
  applyXhsConservativePublishOptions,
  getXhsPlatformStaggerDelayMs,
  isXhsPlatform,
} from "../../shared/xhsPublishPolicy.js";
import { resolveEffectivePublishMode } from "../../shared/accountPublishSettings.js";
import {
  accountLoginFlagNameOf,
  buildAccountPartitionOf,
  recordAccountKeyOf,
  recordAccountNameOf,
  recordGroupOf,
} from "../../shared/accountIdentity.js";
import {
  buildVideoLinkOption,
  getDisplayableVideoLinkTypes,
  getVideoLinkTypeCapability,
  normalizeCollectionName,
  platformSupportsCollection,
  platformSupportsVideoLink,
  resolveCollectionOption,
  resolveVideoLinkOption,
  validateVideoLinkValue,
  VIDEO_LINK_TYPES,
} from "../../shared/videoLink.js";
import {
  isBt2SelectAllShortcut,
  isVideohaoBt2AllowedChar,
  sanitizeVideohaoBt2Input,
  validateVideohaoBt2 as validateVideohaoBt2Value,
} from "@/utils/localVideoPublishBt2";
import { normalizeVideoMetadata } from "../../shared/videoMetadata.js";
import {
  PLATFORM_RULES,
  applyPlatformPublishRules,
  createAppliedRuleSnapshot,
  getPlatformRule,
  normalizePlatformTextMap,
  previewPlatformPublishAdjustments,
  resolvePlatformRuleKey,
} from "../../shared/platformRules.js";
import {
  sanitizeTitle,
  sanitizeDescription,
  splitAndSanitizeTags,
} from "../../shared/textSanitize.js";
import { parsePublishAtUtc8 } from "../../shared/publishThrottle.js";
import AiGenerateButton from "@/components/ai/AiGenerateButton.vue";

const TITLE_OVERRIDE_PLATFORMS = [
  { pt: "抖音", hint: "≤30字" },
  { pt: "百家号", hint: "≤20字" },
  { pt: "小红书", hint: "≤20字" },
  { pt: "头条", hint: "≤30字" },
  { pt: "哔哩哔哩", hint: "≤80字" },
  { pt: "快手", hint: "并入正文" },
];

const PRECHECK_ALL_PLATFORMS = [
  "抖音",
  "视频号",
  "快手",
  "百家号",
  "头条",
  "小红书",
  "哔哩哔哩",
];

function safeResolvePlatformRuleKey(pt) {
  if (typeof resolvePlatformRuleKey === "function") {
    const r = resolvePlatformRuleKey(pt);
    if (r) return r;
  }
  return String(pt || "").trim();
}

function safeGetPlatformRule(pt) {
  if (typeof getPlatformRule === "function") {
    const r = getPlatformRule(pt);
    if (r && typeof r === "object") return r;
  }
  if (PLATFORM_RULES && typeof PLATFORM_RULES === "object") {
    const k = safeResolvePlatformRuleKey(pt);
    if (k && PLATFORM_RULES[k]) return PLATFORM_RULES[k];
  }
  return null;
}

function safeNormalizePlatformTextMap(raw, kind = "title") {
  if (typeof normalizePlatformTextMap === "function") {
    const res = normalizePlatformTextMap(raw, kind);
    if (res && typeof res === "object") return res;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const s = String(v == null ? "" : v).trim();
    if (s) out[k] = s;
  }
  return out;
}

function safeApplyPlatformRules(pt, input, options) {
  if (typeof applyPlatformPublishRules === "function") {
    const res = applyPlatformPublishRules(pt, input, options);
    if (res && typeof res === "object" && typeof res.title === "string") {
      return res;
    }
  }
  return null;
}

function safePreviewPlatformRules(platforms, input) {
  if (typeof previewPlatformPublishAdjustments === "function") {
    const res = previewPlatformPublishAdjustments(platforms, input);
    if (Array.isArray(res)) return res;
  }
  return [];
}

function safeCreateAppliedRuleSnapshot(ruled) {
  if (typeof createAppliedRuleSnapshot === "function") {
    const snap = createAppliedRuleSnapshot(ruled);
    if (snap && typeof snap === "object") return snap;
  }
  return null;
}

function fileBaseName(p) {
  if (!p) return "";
  const s = String(p).replace(/\\/g, "/");
  const seg = s.split("/");
  return seg[seg.length - 1] || "";
}

function fileStem(p) {
  const b = fileBaseName(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

function parseBqToTags(raw) {
  return splitAndSanitizeTags(raw);
}

/** 话题平台依赖「#词」；标签多选无 # 时自动补上，已带 # 的不重复添加 */
function formatBqFromTags(tags) {
  return (Array.isArray(tags) ? tags : [])
    .map((t) => String(t).trim())
    .filter(Boolean)
    .map((t) => (t.startsWith("#") ? t : `#${t}`))
    .join(" ");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DY_SYNC_TOUTIAO_STORAGE_KEY = "matrixmedia.publish.dySyncToutiao";
const DY_SYNC_TOUTIAO_CONFLICT_MESSAGE =
  "已勾选头条账号，又开启抖音同步头条，会重复发布，请二选一";

function readDySyncToutiaoPreference() {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return false;
    return localStorage.getItem(DY_SYNC_TOUTIAO_STORAGE_KEY) === "true";
  } catch (_) {
    return false;
  }
}

function writeDySyncToutiaoPreference(enabled) {
  try {
    if (typeof localStorage === "undefined" || !localStorage) return;
    localStorage.setItem(
      DY_SYNC_TOUTIAO_STORAGE_KEY,
      enabled === true ? "true" : "false"
    );
  } catch (_) {
    /* ignore */
  }
}

function readRecordDySyncToutiao(record) {
  if (!record || typeof record !== "object") return undefined;
  if (
    record.publishOptions &&
    typeof record.publishOptions.dySyncToutiao === "boolean"
  ) {
    return record.publishOptions.dySyncToutiao;
  }
  if (typeof record.dySyncToutiao === "boolean") {
    return record.dySyncToutiao;
  }
  if (record.data && typeof record.data.dySyncToutiao === "boolean") {
    return record.data.dySyncToutiao;
  }
  return undefined;
}

function republishRecordIdentityKey(target) {
  const pt = String((target && target.pt) || "").trim();
  if (target && target.partition) {
    return `p__${String(target.partition)}`;
  }
  const acctKey =
    (target && target.accountKey) ||
    (typeof recordAccountKeyOf === "function"
      ? recordAccountKeyOf(target || {})
      : "") ||
    (target && target.phone) ||
    "";
  return `k__${String(acctKey)}__${pt}`;
}

/**
 * 历史重发专用：仅以原任务记录（或显式 form.dySyncToutiao）为准预填，
 * 原记录没有该字段（含旧任务与未开启同步的任务）一律按 false，
 * 绝不读取也不覆盖 localStorage 中的默认偏好。
 */
function resolveRepublishDySyncToutiao(
  form = {},
  records = [],
  failedTargets = []
) {
  if (form && typeof form.dySyncToutiao === "boolean") {
    return form.dySyncToutiao === true;
  }
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (list.length === 0) return false;
  const dyRecords = list.filter((r) =>
    String((r && r.pt) || "").includes("抖音")
  );
  let candidates = dyRecords.length > 0 ? dyRecords : list;
  if (
    dyRecords.length > 0 &&
    Array.isArray(failedTargets) &&
    failedTargets.length > 0
  ) {
    const failedKeySet = new Set(
      failedTargets.map((t) => republishRecordIdentityKey(t))
    );
    const failedDy = dyRecords.filter((r) =>
      failedKeySet.has(republishRecordIdentityKey(r))
    );
    if (failedDy.length > 0) {
      candidates = failedDy;
    }
  }
  // 合并行里若有记录未开启同步（含缺字段），保守按 false：宁可漏同步，不误同步到头条
  return candidates.every((rec) => readRecordDySyncToutiao(rec) === true);
}

export default {
  name: "LocalVideoPublish",
  components: { AiGenerateButton },
  data() {
    return {
      ptConfig,
      metaVisible: false,
      platformVisible: false,
      attrsVisible: false,
      previewVisible: false,
      localFilePath: "",
      bqTags: [],
      bqComposing: false,
      platformStatements: {},
      platformVideoLinks: {},
      platformCollections: {},
      batchCollection: "",
      platformProductOptions: {},
      platformProductLoading: {},
      // 短剧/剧集搜索下拉：key 为 `${nodeId}:${linkType}`
      // options  —— 服务端返回的搜索结果（下拉渲染内容，随每次搜索整体替换）
      // searched —— 是否已搜过（用于区分「还没搜」和「搜了没结果」的提示文案）
      // seq      —— 各 key 当前的请求序号（用于丢弃乱序返回的过期结果，
      //              清空时也推进以作废在途请求）
      // componentSeq —— 全局单调序号源，只增不减（见 nextPlatformEntitySeq）
      platformEntityOptions: {},
      platformEntitySearched: {},
      platformEntitySeq: {},
      platformEntityLoading: {},
      componentSeq: 0,
      checkedPlatformIds: [],
      checkAllPlatforms: false,
      checkAllIndeterminate: false,
      defaultCreativeStatement: DEFAULT_PUBLISH_CREATIVE_STATEMENT,
      batchCreativeStatement: DEFAULT_PUBLISH_CREATIVE_STATEMENT,
      throttlePreviewVisible: false,
      throttlePreviewRows: [],
      throttlePreviewHasExplicitTime: false,
      _throttlePreviewResolver: null,
      form: {
        title: "",
        bt1: "",
        description: "",
        shortTitle: "",
        // 分平台覆盖标题（key 为规范平台中文名，如 抖音 / 百家号 / 小红书 / 头条 / 哔哩哔哩 / 快手）
        titleByPlatform: {},
        // 自定义封面图片绝对路径（竖版 3:4；发布第一步选图；重发时从历史记录带入）
        coverPath: "",
        // 横版封面绝对路径（4:3，仅抖音 / 视频号生效；留空时有竖封面则自动生成）
        coverPathH: "",
        noDownload: false,
        dySyncToutiao: readDySyncToutiaoPreference(),
      },
      thisShow: false,
      closeWindow: true,
      scheduledPublish: false,
      publishAt: "",
      republishContext: null,
      republishTextOtherName: "",
      showLoginDialog: false,
      loginData: {},
      treeData: [],
      taskHandlers: new Map(),
      defaultProps: {
        children: "children",
        label: "title",
      },
      // Directory batch publish state
      dirPublishVisible: false,
      dirPath: "",
      dirXlsxRows: [], // [{fileName, title, description, tags, shortTitle, coverPath}]
      dirXlsxError: "",
      dirBatchFiles: [],
      publishing: false,
    };
  },
  computed: {
    displayFileName() {
      return fileBaseName(this.localFilePath);
    },
    // 本地视频 file:// 地址（webSecurity:false 下渲染进程可直接播放）；
    // 路径逐段 encode，避免文件名里的 #/& 等字符破坏 URL
    localFileUrl() {
      if (!this.localFilePath) return "";
      const p = String(this.localFilePath).replace(/\\/g, "/");
      return "file://" + p.split("/").map(encodeURIComponent).join("/");
    },
    coverFileName() {
      return this.form.coverPath ? fileBaseName(this.form.coverPath) : "";
    },
    coverHFileName() {
      return this.form.coverPathH ? fileBaseName(this.form.coverPathH) : "";
    },
    isDirBatchMode() {
      return Array.isArray(this.dirBatchFiles) && this.dirBatchFiles.length > 0;
    },
    platformTitleOverrideList() {
      return TITLE_OVERRIDE_PLATFORMS.map((item) => {
        const rule = safeGetPlatformRule(item.pt);
        const hint =
          rule && rule.titleMax != null
            ? `≤${rule.titleMax}字`
            : item.hint;
        return { pt: item.pt, hint };
      });
    },
    metaRuleWarnings() {
      const title = String((this.form && this.form.bt1) || "").trim();
      const description = String(
        (this.form && this.form.description) || ""
      ).trim();
      const tags = Array.isArray(this.bqTags) ? this.bqTags : [];
      const titleByPlatform =
        (this.form && this.form.titleByPlatform) || {};
      if (
        !title &&
        !description &&
        tags.length === 0 &&
        Object.keys(titleByPlatform).length === 0
      ) {
        return [];
      }
      return safePreviewPlatformRules(PRECHECK_ALL_PLATFORMS, {
        title,
        description,
        shortTitle: (this.form && this.form.shortTitle) || "",
        tags,
        titleByPlatform,
      });
    },
    checkedPlatformRuleWarnings() {
      const nodes = this.checkedPlatformNodes || [];
      if (!nodes.length) return [];
      const platforms = nodes.map((n) => n.pt);
      if (this.isDirBatchMode) {
        const warnings = [];
        for (const row of this.dirBatchFiles || []) {
          const stem = String((row && row.fileName) || "").replace(
            /\.[^/.]+$/,
            ""
          );
          const rowWarnings = safePreviewPlatformRules(platforms, {
            title: (row && row.title) || stem,
            description: (row && row.description) || "",
            shortTitle: (row && row.shortTitle) || "",
            tags: (row && row.tags) || "",
            titleByPlatform: (row && row.titleByPlatform) || {},
            descByPlatform: (row && row.descByPlatform) || {},
          });
          for (const w of rowWarnings) {
            warnings.push({
              key: `${row.fileName}:${w.platform}`,
              platform: w.platform,
              adjustments: w.adjustments,
              summary: `${row.fileName} ${w.summary}`,
            });
          }
        }
        return warnings;
      }
      return safePreviewPlatformRules(platforms, {
        title: (this.form && this.form.bt1) || "",
        description: (this.form && this.form.description) || "",
        shortTitle: (this.form && this.form.shortTitle) || "",
        tags: Array.isArray(this.bqTags) ? this.bqTags : [],
        titleByPlatform: (this.form && this.form.titleByPlatform) || {},
      }).map((w) => ({
        ...w,
        key: w.platform,
      }));
    },
    batchStatementOptions() {
      return CREATIVE_STATEMENT_OPTIONS;
    },
    checkedPlatformNodes() {
      // 依赖 checkedPlatformIds（响应式），避免只依赖 $refs 导致 computed 不更新；
      // 再从 treeData 里按 id 还原节点。
      const ids = this.checkedPlatformIds;
      if (!ids || ids.length === 0) return [];
      const idSet = new Set(ids);
      const result = [];
      (this.treeData || []).forEach((group) => {
        (group.children || []).forEach((child) => {
          if (child && child.url && idSet.has(child.id)) result.push(child);
        });
      });
      return result;
    },
    attrsHasSph() {
      return this.checkedPlatformNodes.some((node) =>
        platformSupportsVideoLink(node.pt)
      );
    },
    attrsHasProductLink() {
      return this.checkedPlatformNodes.some((node) => {
        const info = this.getPlatformVideoLinkTypeInfo(node);
        return info && ["product_url", "exact_product_name"].includes(info.selectionMode);
      });
    },
    attrsHasEntityLink() {
      return this.checkedPlatformNodes.some((node) => {
        const type = this.getPlatformVideoLinkType(node.id, node.pt);
        return type === "mini_drama" || type === "sph_series";
      });
    },
    attrsDialogTitle() {
      return this.attrsHasSph ? "设置第三方属性" : "确认发布账号";
    },
  },
  mounted() {
    this._onGetCookieDone = (event, data) => {
      const { taskId } = data;
      const handler = this.taskHandlers.get(taskId);
      if (handler) {
        handler(data);
        this.taskHandlers.delete(taskId);
      }
    };
    ipcRenderer.on("getCookie-done", this._onGetCookieDone);
    this.loadPublishThrottleDefaults();
  },
  beforeDestroy() {
    if (this._onGetCookieDone) {
      ipcRenderer.removeListener("getCookie-done", this._onGetCookieDone);
    }
  },
  methods: {
    platformSupportsCreativeStatement,
    /** AI 生成素材：名称（默认文件名）+ 已填的标题 / 简介 / 标签 */
    getAiContext() {
      return {
        contentType: "video",
        name: this.form.title,
        title: this.form.bt1,
        body: this.form.description,
        tags: this.bqTags,
      };
    },
    onAiTitle(value) {
      this.form.bt1 = value;
    },
    onAiBody(value) {
      this.form.description = String(value || "").slice(0, 2000);
    },
    /** 生成的标签追加到已有标签后，自动去重 */
    onAiTags(list) {
      this._pushBqTags(list);
    },
    platformSupportsVideoLink,
    platformSupportsCollection,
    /** 把字符串按 # / 空格 / 逗号 / 分号 / 顿号 切成多个标签 */
    _splitBqTokens(raw) {
      if (!raw) return [];
      return (
        String(raw)
          // 在每个 # 前插入空格，保证 "#a#b" 也能切开
          .replace(/#/g, " #")
          .split(/[\s,，、;；]+/)
          .map((s) => s.trim().replace(/^#+/, "").trim())
          .filter(Boolean)
      );
    },
    _pushBqTags(list) {
      if (!Array.isArray(list) || !list.length) return 0;
      const exist = new Set((this.bqTags || []).map((t) => String(t)));
      let added = 0;
      for (const t of list) {
        const v = String(t || "").trim();
        if (!v) continue;
        if (exist.has(v)) continue;
        this.bqTags.push(v);
        exist.add(v);
        added += 1;
      }
      return added;
    },
    /** 清空 el-select 内部正在输入的搜索词 */
    _clearBqInput() {
      this.$nextTick(() => {
        const root = this.$refs.bqSelect && this.$refs.bqSelect.$el;
        if (!root) return;
        const input = root.querySelector("input.el-select__input");
        if (!input) return;
        input.value = "";
        // 同步 el-select 内部 query 状态
        input.dispatchEvent(new Event("input", { bubbles: true }));
        try {
          const sel = this.$refs.bqSelect;
          if (sel) sel.query = "";
        } catch (_) {
          /* ignore */
        }
      });
    },
    onBqPaste(e) {
      try {
        const cd = e.clipboardData || window.clipboardData;
        if (!cd) return;
        const text = cd.getData("text") || "";
        if (!text) return;
        const tokens = this._splitBqTokens(text);
        // 只有单个普通词（没有 # / 分隔符）就走原始粘贴流程
        if (tokens.length <= 1 && !/[#\s,，、;；]/.test(text)) return;
        e.preventDefault();
        e.stopPropagation();
        this._pushBqTags(tokens);
        this._clearBqInput();
      } catch (_) {
        /* ignore，回落到默认行为 */
      }
    },
    onBqCompositionStart() {
      this.bqComposing = true;
    },
    onBqCompositionEnd() {
      this.bqComposing = false;
    },
    onBqKeydown(e) {
      // 中文等 IME 组合输入中，空格用于选词，不能当作添加标签
      if (this.bqComposing || e.isComposing || e.keyCode === 229) return;
      // 只拦截空格键
      if (e.key !== " " && e.code !== "Space" && e.keyCode !== 32) return;
      const target = e.target;
      if (!target || target.tagName !== "INPUT") return;
      const raw = String(target.value || "");
      const tokens = this._splitBqTokens(raw);
      if (!tokens.length) {
        // 空内容按空格，直接阻止留下空白
        e.preventDefault();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this._pushBqTags(tokens);
      this._clearBqInput();
    },
    async chooseCoverImage() {
      const picked = await ipcRenderer.invoke("dialog:openImageFile");
      if (picked) this.form.coverPath = picked;
    },
    async chooseCoverHImage() {
      const picked = await ipcRenderer.invoke("dialog:openImageFile");
      if (picked) this.form.coverPathH = picked;
    },
    platformSupportsTitleOverride(pt) {
      const canonical = safeResolvePlatformRuleKey(pt);
      return TITLE_OVERRIDE_PLATFORMS.some((it) => it.pt === canonical);
    },
    getPlatformTitleOverride(pt) {
      const canonical = safeResolvePlatformRuleKey(pt);
      const map = (this.form && this.form.titleByPlatform) || {};
      return String(map[canonical] || "");
    },
    setPlatformTitleOverride(pt, value) {
      const canonical = safeResolvePlatformRuleKey(pt);
      if (!canonical) return;
      if (!this.form.titleByPlatform || typeof this.form.titleByPlatform !== "object") {
        this.$set(this.form, "titleByPlatform", {});
      }
      const nextVal = String(value == null ? "" : value);
      if (!nextVal) {
        if (this.$delete) {
          this.$delete(this.form.titleByPlatform, canonical);
        } else {
          delete this.form.titleByPlatform[canonical];
        }
      } else {
        this.$set(this.form.titleByPlatform, canonical, nextVal);
      }
    },
    getPlatformTitleOverridePlaceholder(pt) {
      const rule = safeGetPlatformRule(pt);
      if (rule && rule.titleMax != null) {
        return `留空用通用标题（≤${rule.titleMax}字）`;
      }
      return "留空用通用标题";
    },
    getCheckedPlatformRowWarning(pt) {
      const canonical = safeResolvePlatformRuleKey(pt);
      const hit = (this.checkedPlatformRuleWarnings || []).find(
        (w) => w.platform === canonical
      );
      return hit ? hit.summary : "";
    },
    formatRowPlatformOverrides(row) {
      if (!row || typeof row !== "object") return "";
      const parts = [];
      const titles =
        row.titleByPlatform && typeof row.titleByPlatform === "object"
          ? row.titleByPlatform
          : {};
      const descs =
        row.descByPlatform && typeof row.descByPlatform === "object"
          ? row.descByPlatform
          : {};
      for (const k of Object.keys(titles)) {
        if (titles[k]) parts.push(`${k}标题`);
      }
      for (const k of Object.keys(descs)) {
        if (descs[k]) parts.push(`${k}简介`);
      }
      return parts.join(" / ");
    },
    /**
     * 封面文件发布前校验（GUI 直发不经 runSingleFilePublish 的 resolveCoverPath，
     * 不在这里拦就会到上传阶段才失败，视频白传一次）：
     * 文件必须存在；勾选视频号时仅收 jpg/png（上传控件 accept 限制）。
     * @returns {string} 错误消息，空串表示通过
     */
    validateCoverPath(coverPath, platformNames = [], label = "封面") {
      const p = String(coverPath || "").trim();
      if (!p) return "";
      let stat = null;
      try {
        stat = require("fs").statSync(p);
      } catch (_) {
        return `${label}文件不存在: ${p}`;
      }
      if (!stat.isFile()) return `${label}路径不是文件: ${p}`;
      const needSph = (platformNames || []).some((pt) =>
        String(pt || "").includes("视频号")
      );
      if (needSph && !/\.(jpe?g|png)$/i.test(p)) {
        return `视频号${label}仅支持 jpg/png 格式: ${p}`;
      }
      return "";
    },
    // filePath 为空时直接弹窗、由拖入区选文件；有值则带入并重置表单
    open(filePath) {
      this.localFilePath = filePath || "";
      const defaultTitle = fileStem(filePath);
      this.bqTags = [];
      this.bqComposing = false;
      this.loadPublishThrottleDefaults();
      this.resetPlatformStatementState();
      this.resetPlatformVideoLinks();
      this.resetPlatformCollections();
      this.form = {
        title: defaultTitle,
        bt1: "",
        description: "",
        shortTitle: "",
        titleByPlatform: {},
        coverPath: "",
        coverPathH: "",
        noDownload: false,
        dySyncToutiao: readDySyncToutiaoPreference(),
      };
      this.thisShow = false;
      this.closeWindow = true;
      this.scheduledPublish = false;
      this.publishAt = "";
      this.republishContext = null;
      this.republishTextOtherName = "";
      this.metaVisible = true;
    },
    // 上一步：回到选文件环节，弹系统文件框换一个视频；换文件后按新文件重置表单
    async reselectVideoFile() {
      const path = await ipcRenderer.invoke("dialog:openVideoFile");
      if (!path) return;
      this.open(path);
    },
    // 已选文件行支持直接拖入视频文件替换（#72）
    onFileLineDrop(e) {
      const file =
        (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) ||
        null;
      if (!file) return;
      const path = file.path || "";
      const ext = path.split(".").pop().toLowerCase();
      if (!["mp4", "mov", "mkv", "avi", "webm", "m4v"].includes(ext)) {
        this.$message.warning("请拖入视频文件（支持 mp4/mov/mkv/avi/webm/m4v）");
        return;
      }
      this.open(path);
    },
    openRepublish(payload = {}) {
      const filePath = payload.filePath || "";
      if (!filePath) {
        this.$message.warning("缺少历史视频路径，无法重发");
        return false;
      }
      this.localFilePath = filePath;
      const defaultTitle = fileStem(filePath);
      const form = payload.form || {};
      const dySyncToutiao = resolveRepublishDySyncToutiao(
        form,
        payload.records,
        payload.failedTargets
      );
      this.form = {
        title: (form.title || defaultTitle || "").trim(),
        bt1: (form.bt1 || "").trim(),
        description: (form.description || form.bdText || "").trim(),
        shortTitle: (form.shortTitle || form.bt2Filled || "").trim(),
        titleByPlatform: safeNormalizePlatformTextMap(form.titleByPlatform, "title"),
        coverPath: (form.coverPath || "").trim(),
        coverPathH: (form.coverPathH || "").trim(),
        noDownload: form.noDownload === true,
        dySyncToutiao,
      };
      this.bqTags = parseBqToTags(form.tags || form.bq);
      this.loadPublishThrottleDefaults();
      this.resetPlatformStatementState();
      this.resetPlatformVideoLinks();
      this.resetPlatformCollections();
      this.thisShow = false;
      this.closeWindow = true;
      this.scheduledPublish = false;
      this.publishAt = "";
      this.republishTextOtherName = payload.textOtherName || fileStem(filePath);
      this.republishContext = {
        records: Array.isArray(payload.records) ? payload.records : [],
        failedTargets: Array.isArray(payload.failedTargets)
          ? payload.failedTargets
          : [],
      };
      this.metaVisible = false;
      this.loadAccounts();
      this.platformVisible = true;
      this.$nextTick(() => {
        const checkedKeys = this.resolveRepublishCheckedKeys(
          this.republishContext.failedTargets
        );
        if (this.$refs.tree) {
          this.$refs.tree.setCheckedKeys(checkedKeys);
        }
        this.applyRepublishPlatformStatements(form.creativeStatement);
        this.applyRepublishPlatformVideoLinks();
        this.applyRepublishPlatformCollections();
        this.onTreeCheck();
      });
      return true;
    },
    resolveRepublishCheckedKeys(failedTargets = []) {
      if (!Array.isArray(failedTargets) || failedTargets.length === 0)
        return [];
      const keys = [];
      // 新分组模型：优先按 partition 匹配（同一分组同平台多账号时
      // phone 前缀不再唯一），老记录缺失 partition 时回退账号登录主键
      const targetSet = new Set(
        failedTargets.map((v) => this.republishTargetKey(v))
      );
      (this.treeData || []).forEach((group) => {
        (group.children || []).forEach((child) => {
          if (targetSet.has(this.republishTargetKey(child))) {
            keys.push(child.id);
          }
        });
      });
      return keys;
    },
    /** 重发匹配键：partition 优先，回退「登录主键 + 平台」 */
    republishTargetKey(target) {
      const pt = String((target && target.pt) || "").trim();
      if (target && target.partition) {
        return `p__${String(target.partition)}`;
      }
      return `k__${recordAccountKeyOf(target || {})}__${pt}`;
    },

    /**
     * 按平台 + 账号身份查重发记录。
     * @param {string} pt 平台
     * @param {object} node 账号树子节点（含 accountKey / partition）
     */
    findRepublishRecord(pt, node) {
      if (
        !this.republishContext ||
        !Array.isArray(this.republishContext.records)
      )
        return null;
      const records = this.republishContext.records;
      const nodePartition = String((node && node.partition) || "");
      const nodeKey = recordAccountKeyOf(node || {});
      if (nodePartition) {
        const byPartition = records.find(
          (item) =>
            String(item.pt || "") === String(pt || "") &&
            String(item.partition || "") === nodePartition
        );
        if (byPartition) return byPartition;
      }
      return records.find(
        (item) =>
          String(item.pt || "") === String(pt || "") &&
          recordAccountKeyOf(item) === nodeKey
      );
    },

    defaultBookName() {
      return fileStem(this.localFilePath) || "";
    },

    buildVideoPayload() {
      const bookName =
        sanitizeTitle(this.form.title) || this.defaultBookName();
      const bt1 = sanitizeTitle(this.form.bt1);
      const titleByPlatform = safeNormalizePlatformTextMap(
        this.form.titleByPlatform,
        "title"
      );
      const coverPathH = (this.form.coverPathH || "").trim();
      const metadata = normalizeVideoMetadata({
        title: bt1,
        description: sanitizeDescription(this.form.description),
        shortTitle: sanitizeTitle(this.form.shortTitle),
        tags: splitAndSanitizeTags(this.bqTags),
      });
      return {
        bookName,
        textType: "local",
        data: {
          textOtherName:
            this.republishTextOtherName || fileStem(this.localFilePath),
          title: metadata.title,
          description: metadata.description,
          shortTitle: metadata.shortTitle,
          tags: metadata.tags,
          ...metadata.legacy,
          bq: formatBqFromTags(metadata.tags),
          coverPath: (this.form.coverPath || "").trim(),
          ...(coverPathH ? { coverPathH } : {}),
          ...(Object.keys(titleByPlatform).length > 0 ? { titleByPlatform } : {}),
          noDownload: this.form.noDownload === true,
        },
      };
    },
    async confirmDuplicatePublishTargets(targets) {
      if (
        !Array.isArray(targets) ||
        targets.length === 0 ||
        !ipcRenderer ||
        typeof ipcRenderer.invoke !== "function"
      ) {
        return { proceed: true, allowDuplicate: false };
      }
      let duplicates = [];
      try {
        const res = await ipcRenderer.invoke("publish:check-duplicate", {
          targets,
        });
        duplicates = res && Array.isArray(res.duplicates) ? res.duplicates : [];
      } catch (_) {
        return { proceed: true, allowDuplicate: false };
      }
      if (!duplicates.length) {
        return { proceed: true, allowDuplicate: false };
      }
      const lines = duplicates
        .slice(0, 6)
        .map(
          (d) =>
            `${d.platform}（${d.phone || "当前账号"}）「${d.title}」— 上次发布时间：${
              d.lastPublishAtText || "近 7 天内"
            }`
        );
      if (duplicates.length > 6) {
        lines.push(`…等共 ${duplicates.length} 条重复记录`);
      }
      try {
        await this.$confirm(
          `检测到以下平台 7 天内已有相同标题的成功/进行中发布记录：\n${lines.join(
            "\n"
          )}\n是否仍然发布？`,
          "重复发布提醒",
          {
            confirmButtonText: "仍然发布",
            cancelButtonText: "取消",
            type: "warning",
          }
        );
        return { proceed: true, allowDuplicate: true };
      } catch (_) {
        return { proceed: false, allowDuplicate: false };
      }
    },
    async loadPublishThrottleDefaults() {
      if (!ipcRenderer || typeof ipcRenderer.invoke !== "function") {
        return this.defaultCreativeStatement || DEFAULT_PUBLISH_CREATIVE_STATEMENT;
      }
      try {
        const res = await ipcRenderer.invoke("publish-throttle:get-settings");
        const configured =
          res && res.settings && res.settings.defaultCreativeStatement;
        if (configured) {
          this.defaultCreativeStatement = normalizeCreativeStatement(configured);
        }
      } catch (_) {
        /* 保持当前默认声明 */
      }
      return this.defaultCreativeStatement || DEFAULT_PUBLISH_CREATIVE_STATEMENT;
    },
    resolveThrottlePreview(action) {
      const resolver = this._throttlePreviewResolver;
      this._throttlePreviewResolver = null;
      this.throttlePreviewVisible = false;
      if (typeof resolver === "function") {
        resolver(action);
      }
    },
    onThrottlePreviewDialogClose() {
      if (typeof this._throttlePreviewResolver === "function") {
        const resolver = this._throttlePreviewResolver;
        this._throttlePreviewResolver = null;
        resolver("cancel");
      }
    },
    /**
     * 批量发布（单视频多平台 / 目录批量）点击「发布」前弹出节流排期预览表，
     * 展示 平台 / 账号 / 计划时间 / 原因，供用户确认或改为不节流。
     * 确认时由主进程加锁重算并写账本预留：
     * - 显式 publishAt 已过期或排期已满 → 返回错误让用户重选，不得继续提交
     * - 预览期间有其他入口占用名额导致排期变化 → 刷新预览表让用户重新确认，不得用旧预览提交
     */
    async confirmThrottlePublishPlan(planEntries, options = {}) {
      if (
        !Array.isArray(planEntries) ||
        planEntries.length === 0 ||
        !ipcRenderer ||
        typeof ipcRenderer.invoke !== "function"
      ) {
        return {
          proceed: true,
          noThrottle: true,
          itemsByKey: new Map(),
          reservationIds: [],
        };
      }

      const activeEntries = planEntries.filter((e) => !e.isDraft);
      if (activeEntries.length === 0) {
        return {
          proceed: true,
          noThrottle: true,
          itemsByKey: new Map(),
          reservationIds: [],
        };
      }

      const targetsPayload = activeEntries.map((e) => ({
        platform: e.pt,
        phone: e.phone,
        accountKey: e.accountKey,
        partition: e.partition,
        filePath: e.filePath || "",
        textType: e.textType || "local",
      }));

      const buildPreviewState = (planItems) => {
        const itemsByKey = new Map();
        let activeIdx = 0;
        const previewRows = planEntries.map((entry) => {
          if (entry.isDraft) {
            return {
              pt: entry.pt,
              phone: entry.phone,
              title: entry.title,
              isDraft: true,
              scheduled: false,
              plannedTimeText: "保存草稿",
              reasonText: "账号默认保存草稿（不节流）",
            };
          }
          const planItem = planItems[activeIdx++];
          if (planItem) {
            itemsByKey.set(entry.key, planItem);
          }
          const scheduled = Boolean(planItem && planItem.scheduled);
          const plannedTimeText = scheduled
            ? planItem.publishAt || options.publishAt || "定时发布"
            : "立即发布";
          const reasonText =
            (planItem && planItem.reason) ||
            (scheduled
              ? "按指定定时时间发布"
              : "满足节流规则，立即发布");
          return {
            pt: entry.pt,
            phone: entry.phone,
            title: entry.title,
            isDraft: false,
            scheduled,
            plannedTimeText,
            reasonText,
          };
        });
        return { itemsByKey, previewRows };
      };

      const buildCommittedMap = (committedItems, fallbackItems) => {
        const list =
          Array.isArray(committedItems) && committedItems.length > 0
            ? committedItems
            : fallbackItems;
        const map = new Map();
        for (let i = 0; i < activeEntries.length; i++) {
          if (list[i]) {
            map.set(activeEntries[i].key, list[i]);
          }
        }
        return map;
      };

      let res;
      try {
        res = await ipcRenderer.invoke("publish-throttle:plan", {
          targets: targetsPayload,
          publishAt: options.publishAt || null,
          publishAtMs: options.publishAtMs || null,
        });
      } catch (e) {
        if (this.$message) {
          this.$message.error(
            "计算发布排期失败：" + ((e && e.message) || String(e))
          );
        }
        return {
          proceed: false,
          noThrottle: false,
          itemsByKey: new Map(),
          reservationIds: [],
        };
      }

      if (!res || res.ok !== true) {
        if (this.$message) {
          this.$message.warning(
            (res && (res.message || res.error)) || "发布排期校验失败，请重新选择"
          );
        }
        return {
          proceed: false,
          noThrottle: false,
          itemsByKey: new Map(),
          reservationIds: [],
        };
      }

      // 节流总开关关闭时不弹预览表，但仍走主进程加锁提交（校验显式时间未过期并写入账本）
      if (res.enabled === false) {
        let commitRes;
        try {
          commitRes = await ipcRenderer.invoke("publish-throttle:commit-plan", {
            targets: targetsPayload,
            publishAt: options.publishAt || null,
            publishAtMs: options.publishAtMs || null,
            noThrottle: true,
          });
        } catch (e) {
          if (this.$message) {
            this.$message.error(
              "提交发布排期失败：" + ((e && e.message) || String(e))
            );
          }
          return {
            proceed: false,
            noThrottle: false,
            itemsByKey: new Map(),
            reservationIds: [],
          };
        }
        if (!commitRes || commitRes.ok !== true) {
          if (this.$message) {
            this.$message.warning(
              (commitRes && (commitRes.message || commitRes.error)) ||
                "发布时间已失效或排期失败，请重新选择"
            );
          }
          return {
            proceed: false,
            noThrottle: false,
            itemsByKey: new Map(),
            reservationIds: [],
          };
        }
        return {
          proceed: true,
          noThrottle: true,
          itemsByKey: buildCommittedMap(commitRes.items, res.items || []),
          reservationIds: Array.isArray(commitRes.reservationIds)
            ? commitRes.reservationIds
            : [],
        };
      }

      let currentPlanItems = Array.isArray(res.items) ? res.items : [];
      let currentPreviewBaseMs =
        typeof res.previewBaseMs === "number" && Number.isFinite(res.previewBaseMs)
          ? res.previewBaseMs
          : typeof res.nowMs === "number" && Number.isFinite(res.nowMs)
          ? res.nowMs
          : Date.now();
      while (true) {
        const { previewRows } = buildPreviewState(currentPlanItems);
        this.throttlePreviewRows = previewRows;
        this.throttlePreviewHasExplicitTime = Boolean(options.publishAt);
        this.throttlePreviewVisible = true;

        const action = await new Promise((resolve) => {
          this._throttlePreviewResolver = resolve;
        });
        if (action === "cancel") {
          return {
            proceed: false,
            noThrottle: false,
            itemsByKey: new Map(),
            reservationIds: [],
          };
        }

        const wantNoThrottle = action === "no_throttle";
        let commitRes;
        try {
          commitRes = await ipcRenderer.invoke("publish-throttle:commit-plan", {
            targets: targetsPayload,
            publishAt: options.publishAt || null,
            publishAtMs: options.publishAtMs || null,
            noThrottle: wantNoThrottle,
            previewBaseMs: wantNoThrottle ? null : currentPreviewBaseMs,
            previewItems: wantNoThrottle
              ? null
              : currentPlanItems.map((it) => ({
                  isDraft: Boolean(it && it.isDraft),
                  scheduled: Boolean(it && it.scheduled),
                  plannedAtMs: it ? it.plannedAtMs : null,
                  publishAt: it ? it.publishAt : null,
                  reason: it ? String(it.reason || "") : "",
                  reasons: Array.isArray(it && it.reasons) ? it.reasons : [],
                })),
          });
        } catch (e) {
          if (this.$message) {
            this.$message.error(
              "确认发布排期失败：" + ((e && e.message) || String(e))
            );
          }
          return {
            proceed: false,
            noThrottle: false,
            itemsByKey: new Map(),
            reservationIds: [],
          };
        }

        if (!commitRes || commitRes.ok !== true) {
          if (this.$message) {
            this.$message.warning(
              (commitRes && (commitRes.message || commitRes.error)) ||
                "发布时间已过或排期失败，请重新选择"
            );
          }
          return {
            proceed: false,
            noThrottle: false,
            itemsByKey: new Map(),
            reservationIds: [],
          };
        }

        // 主进程重算结果与预览发生实质偏移（计划时刻差 >60s 或原因/状态变化）：刷新预览表让用户重新确认
        if (commitRes.changed === true) {
          currentPlanItems = Array.isArray(commitRes.items)
            ? commitRes.items
            : [];
          currentPreviewBaseMs =
            typeof commitRes.previewBaseMs === "number" &&
            Number.isFinite(commitRes.previewBaseMs)
              ? commitRes.previewBaseMs
              : typeof commitRes.nowMs === "number" &&
                Number.isFinite(commitRes.nowMs)
              ? commitRes.nowMs
              : Date.now();
          if (this.$message) {
            this.$message.warning(
              commitRes.message || "期间有新的发布任务，排期已更新，请重新确认"
            );
          }
          continue;
        }

        return {
          proceed: true,
          noThrottle: wantNoThrottle,
          itemsByKey: buildCommittedMap(
            commitRes.items,
            wantNoThrottle ? [] : currentPlanItems
          ),
          reservationIds: Array.isArray(commitRes.reservationIds)
            ? commitRes.reservationIds
            : [],
        };
      }
    },
    async writeScheduledPublishRecord(item, reservationId = null) {
      if (ipcRenderer && typeof ipcRenderer.invoke === "function") {
        try {
          const res = await ipcRenderer.invoke(
            "publish-throttle:create-scheduled",
            { item, reservationId }
          );
          if (res && res.ok === true) return res;
          // 严禁在 IPC 拒绝（如时间已过期或写盘失败）时回退备用 dataRequest 写入路径
          return {
            ok: false,
            ...(res && typeof res === "object" ? res : {}),
            message:
              (res && (res.message || res.error)) || "写入定时发布记录失败",
          };
        } catch (e) {
          return {
            ok: false,
            message: (e && e.message) || "写入定时发布记录失败",
          };
        }
      }
      return dataRequest({
        type: "add",
        fileName: "pushData",
        item,
      });
    },
    async releaseThrottleReservations(reservationIds) {
      if (
        !ipcRenderer ||
        typeof ipcRenderer.invoke !== "function" ||
        !reservationIds ||
        (Array.isArray(reservationIds) && reservationIds.length === 0)
      ) {
        return;
      }
      try {
        await ipcRenderer.invoke("publish-throttle:release-reservation", {
          reservationIds: Array.isArray(reservationIds)
            ? reservationIds
            : [reservationIds],
        });
      } catch (_) {
        /* ignore */
      }
    },
    resolvePlatformRulePayload(pt, baseData = {}, options = {}) {
      const titleByPlatform =
        (baseData && baseData.titleByPlatform) ||
        (this.form && this.form.titleByPlatform) ||
        {};
      const descByPlatform = (baseData && baseData.descByPlatform) || {};
      const hasTitle = Boolean(
        (baseData.title != null && String(baseData.title).trim()) ||
          (baseData.bt1 != null && String(baseData.bt1).trim())
      );
      const hasDesc = Boolean(
        (baseData.description != null && String(baseData.description).trim()) ||
          (baseData.bdText != null && String(baseData.bdText).trim())
      );
      const hasShort = Boolean(
        (baseData.shortTitle != null && String(baseData.shortTitle).trim()) ||
          (baseData.bt2Filled != null && String(baseData.bt2Filled).trim())
      );
      const hasTags = Array.isArray(baseData.tags)
        ? baseData.tags.length > 0
        : Boolean(
            (baseData.tags != null && String(baseData.tags).trim()) ||
              (baseData.bq != null && String(baseData.bq).trim())
          );
      const hasMap =
        Object.keys(titleByPlatform || {}).length > 0 ||
        Object.keys(descByPlatform || {}).length > 0;
      if (!hasTitle && !hasDesc && !hasShort && !hasTags && !hasMap) {
        return null;
      }
      return safeApplyPlatformRules(
        pt,
        {
          title: baseData.title != null ? baseData.title : baseData.bt1 || "",
          description:
            baseData.description != null
              ? baseData.description
              : baseData.bdText || "",
          shortTitle:
            baseData.shortTitle != null
              ? baseData.shortTitle
              : baseData.bt2Filled || "",
          tags: baseData.tags !== undefined ? baseData.tags : baseData.bq,
          titleByPlatform,
          descByPlatform,
        },
        options
      );
    },
    buildPlatformVideoPayload(platformNode, baseVideo) {
      const link = buildVideoLinkOption(
        platformNode.pt,
        this.getPlatformVideoLinkType(platformNode.id, platformNode.pt),
        this.getPlatformVideoLinkValue(platformNode.id),
        { shortTitle: this.getPlatformVideoLinkShortTitle(platformNode.id) }
      );
      if (!link.ok) throw new Error(link.error);
      const collection = this.resolvePlatformCollectionValue(
        platformNode.id,
        platformNode.pt
      );
      const dySyncToutiao =
        String((platformNode && platformNode.pt) || "").includes("抖音") &&
        Boolean(this.form && this.form.dySyncToutiao === true);
      const baseData = (baseVideo && baseVideo.data) || {};
      const coverPathH = String(
        baseData.coverPathH || (this.form && this.form.coverPathH) || ""
      ).trim();
      const ruled = this.resolvePlatformRulePayload(platformNode.pt, baseData, {
        log: true,
      });
      let nextData = {
        ...baseData,
        creativeStatement: this.getPlatformStatement(platformNode.id),
      };
      if (ruled && typeof normalizeVideoMetadata === "function") {
        const meta = normalizeVideoMetadata(
          {
            title: ruled.title,
            description: ruled.bodyDescription,
            shortTitle: ruled.shortTitle,
            tags: ruled.tags,
          },
          platformNode.pt
        );
        const hashtagPlatforms = new Set(["视频号", "抖音", "快手"]);
        const nextBq = hashtagPlatforms.has(platformNode.pt)
          ? formatBqFromTags(ruled.tags)
          : ruled.tags.map((t) => String(t).replace(/^#/, "")).join(",");
        const appliedSnapshot = safeCreateAppliedRuleSnapshot(ruled);
        nextData = {
          ...nextData,
          title: meta.title,
          description: meta.description,
          shortTitle: meta.shortTitle,
          tags: meta.tags,
          ...meta.legacy,
          bq: nextBq,
          ...(appliedSnapshot ? { platformRulesApplied: appliedSnapshot } : {}),
          ...(ruled.adjusted
            ? {
                ruleAdjustments: ruled.adjustments,
                ruleAdjustmentsSummary: ruled.summary,
              }
            : {}),
        };
        delete nextData.titleByPlatform;
        delete nextData.descByPlatform;
      }
      if (coverPathH) {
        nextData.coverPathH = coverPathH;
      }
      return {
        ...baseVideo,
        publishOptions: {
          link: link.value,
          ...(collection ? { collection } : {}),
          ...(dySyncToutiao ? { dySyncToutiao: true } : {}),
          ...(coverPathH ? { coverPathH } : {}),
        },
        data: nextData,
      };
    },
    saveDySyncToutiaoPreference(val) {
      // 历史重发会话中仅调整当次重发，不覆盖 localStorage 默认偏好
      if (this.republishContext) return;
      writeDySyncToutiaoPreference(val === true);
    },
    validateDySyncToutiaoConflict(platforms = []) {
      if (!(this.form && this.form.dySyncToutiao === true)) return "";
      const hasToutiao = (platforms || []).some((p) =>
        String((p && p.pt) || "").includes("头条")
      );
      return hasToutiao ? DY_SYNC_TOUTIAO_CONFLICT_MESSAGE : "";
    },
    resetPlatformCollections() {
      this.batchCollection = "";
      this.platformCollections = {};
    },
    getPlatformCollection(nodeId, pt) {
      if (!platformSupportsCollection(pt)) return "";
      const map = this.platformCollections || {};
      if (Object.prototype.hasOwnProperty.call(map, nodeId)) {
        return String(map[nodeId] == null ? "" : map[nodeId]);
      }
      return String(this.batchCollection == null ? "" : this.batchCollection);
    },
    setPlatformCollection(nodeId, value) {
      if (!this.platformCollections) this.platformCollections = {};
      this.$set(
        this.platformCollections,
        nodeId,
        String(value == null ? "" : value)
      );
    },
    resolvePlatformCollectionValue(nodeId, pt, rowCollection = "") {
      if (!platformSupportsCollection(pt)) return "";
      const map = this.platformCollections || {};
      if (Object.prototype.hasOwnProperty.call(map, nodeId)) {
        const resolved = resolveCollectionOption(pt, {
          collection: map[nodeId],
        });
        return resolved.enabled ? resolved.name : "";
      }
      const rowNorm = normalizeCollectionName(rowCollection);
      if (rowNorm) return rowNorm;
      const globalResolved = resolveCollectionOption(pt, {
        collection: this.batchCollection,
      });
      return globalResolved.enabled ? globalResolved.name : "";
    },
    applyBatchCollection(options = {}) {
      const { silent = false } = options;
      const val = normalizeCollectionName(this.batchCollection);
      const targets = (this.checkedPlatformNodes || []).filter((node) =>
        platformSupportsCollection(node.pt)
      );
      if (targets.length === 0) {
        if (!silent && this.$message) {
          this.$message.warning(
            "已勾选账号中没有支持合集的平台（仅支持抖音/快手/视频号）"
          );
        }
        return;
      }
      const next = { ...(this.platformCollections || {}) };
      targets.forEach((node) => {
        next[node.id] = val;
      });
      this.platformCollections = next;
      if (!silent && this.$message) {
        this.$message.success(
          val
            ? `已为 ${targets.length} 个账号设置合集「${val}」`
            : `已清空 ${targets.length} 个账号的合集设置`
        );
      }
    },
    applyRepublishPlatformCollections() {
      const next = { ...(this.platformCollections || {}) };
      this.getAllPlatformLeafNodes().forEach((node) => {
        const rec = this.findRepublishRecord(node.pt, node);
        const col = resolveCollectionOption(node.pt, rec && rec.publishOptions);
        if (col && col.enabled && col.name) {
          next[node.id] = col.name;
        }
      });
      this.platformCollections = next;
    },
    resetPlatformStatementState() {
      this.platformStatements = {};
      this.checkedPlatformIds = [];
      this.checkAllPlatforms = false;
      this.checkAllIndeterminate = false;
      this.batchCreativeStatement = normalizeCreativeStatement(
        this.defaultCreativeStatement || DEFAULT_PUBLISH_CREATIVE_STATEMENT
      );
    },
    resetPlatformVideoLinks() {
      this.platformVideoLinks = {};
      this.platformProductOptions = {};
      this.platformProductLoading = {};
      this.platformEntitySearched = {};
      this.platformEntityOptions = {};
      // 注意：不要清 platformEntitySeq 与 componentSeq。
      // 清了会让序号从头开始，上一次会话遗留的在途响应可能与新会话撞号而复活下拉；
      // 序号源是全局单调的，跨会话继续递增即可。
      this.platformEntityLoading = {};
    },
    getPlatformVideoLinkOptions(platform) {
      return getDisplayableVideoLinkTypes(platform);
    },
    getPlatformVideoLinkType(nodeId, platform) {
      const state = this.platformVideoLinks[nodeId];
      if (state && state.type) return state.type;
      const first = this.getPlatformVideoLinkOptions(platform)[0];
      return first ? first.type : "";
    },
    getPlatformVideoLinkValue(nodeId) {
      const state = this.platformVideoLinks[nodeId];
      return String((state && state.value) || "");
    },
    getPlatformVideoLinkShortTitle(nodeId) {
      return String((this.platformVideoLinks[nodeId] || {}).shortTitle || "");
    },
    setPlatformVideoLinkShortTitle(nodeId, platform, shortTitle) {
      this.$set(this.platformVideoLinks, nodeId, {
        ...this.platformVideoLinks[nodeId],
        type: this.getPlatformVideoLinkType(nodeId, platform),
        shortTitle: String(shortTitle || ""),
      });
    },
    platformVideoLinkNeedsShortTitle(row) {
      return Boolean((this.getPlatformVideoLinkTypeInfo(row) || {}).requiresShortTitle);
    },
    setPlatformVideoLinkType(nodeId, platform, type) {
      const old = this.platformVideoLinks[nodeId] || {};
      this.$set(this.platformVideoLinks, nodeId, {
        type: String(type || ""),
        value: old.type === type ? String(old.value || "") : "",
        shortTitle: old.type === type ? String(old.shortTitle || "") : "",
      });
      // 快手商品挂载尚未经真实账号实机验收（#31），选中商品时提醒用户去 QQ 群反馈
      if (
        String(type || "") === VIDEO_LINK_TYPES.PRODUCT &&
        String(platform || "").includes("快手") &&
        this.$message
      ) {
        this.$message.warning(
          "快手商品挂载暂未经过真实账号完整测试，如遇挂载失败或异常，请加入作者QQ群反馈问题"
        );
      }
    },
    setPlatformVideoLinkValue(nodeId, platform, value) {
      this.$set(this.platformVideoLinks, nodeId, {
        ...this.platformVideoLinks[nodeId],
        type: this.getPlatformVideoLinkType(nodeId, platform),
        value: String(value || ""),
      });
    },
    onAttrsLinkTypeChange(row, type) {
      this.clearPlatformEntityCache(row, type);
      this.setPlatformVideoLinkType(row.id, row.pt, type);
      if (this.platformVideoLinkIsProduct(row)) {
        this.loadPlatformWindowProducts(row);
      }
      // 短剧/剧集：切换后下拉回到空，等用户重新输入回车搜索
    },
    /**
     * 短剧/剧集走「输入即搜 + 列表选择」入口：
     * 打开下拉先铺全量目录，输入即时本地过滤，下拉只渲染返回的剧名；
     * 不提供手输兜底（平台按名称匹配，选中项即名称）。
     */
    platformVideoLinkHasEntityList(data) {
      const type = this.getPlatformVideoLinkType(data.id, data.pt);
      return (
        type === VIDEO_LINK_TYPES.MINI_DRAMA ||
        type === VIDEO_LINK_TYPES.SPH_SERIES
      );
    },
    entityOptionsKey(data) {
      return `${data.id}:${this.getPlatformVideoLinkType(data.id, data.pt)}`;
    },
    getPlatformEntityOptions(data) {
      return this.platformEntityOptions[this.entityOptionsKey(data)] || [];
    },
    platformVideoLinkSearchPlaceholder(data) {
      const type = this.getPlatformVideoLinkType(data.id, data.pt);
      const label = type === VIDEO_LINK_TYPES.SPH_SERIES ? "剧集" : "短剧";
      return `输入${label}名称搜索`;
    },
    platformEntityNoDataText(data) {
      const type = this.getPlatformVideoLinkType(data.id, data.pt);
      const label = type === VIDEO_LINK_TYPES.SPH_SERIES ? "剧集" : "短剧";
      const key = this.entityOptionsKey(data);
      if (this.platformEntityLoading[key]) return "搜索中…";
      if (!this.platformEntitySearched[key]) return `输入${label}名称搜索`;
      return "无匹配结果";
    },
    /**
     * 打开下拉：不做任何请求。
     * 刻意不预热——用户没输入关键词时不该看到加载态，
     * 首开空下拉 + 「输入名称搜索」提示才是正确状态。
     */
    handleEntityDropdownToggle(row, open) {
      if (open) return;
    },
    platformEntityRequestInfo(row) {
      const type = this.getPlatformVideoLinkType(row.id, row.pt);
      const isSeries = type === VIDEO_LINK_TYPES.SPH_SERIES;
      return {
        channel: isSeries ? "sph:list-series" : "sph:list-dramas",
        label: isSeries ? "剧集" : "短剧",
        partition: buildAccountPartitionOf(row, row.pt),
      };
    },
    /**
     * 服务端关键词搜索：输入原样作为 queryString 交给平台接口，
     * 下拉只渲染服务端返回的结果（整体替换，不累加）。
     * 输入为空则清空下拉且不发请求。
     */
    async searchPlatformEntityOptions(row, query) {
      if (!row || !platformSupportsVideoLink(row.pt)) return;
      if (!this.platformVideoLinkHasEntityList(row)) return;
      const key = this.entityOptionsKey(row);
      const keyword = String(query == null ? "" : query).trim();
      if (!keyword) {
        this.clearPlatformEntityOptions(row);
        return;
      }
      // 不拦并发：输入过程中会有多次搜索，靠自增序号丢弃过期结果，
      // 否则慢请求会卡住后续输入（「输入即搜」会变成「打字没反应」）
      const seq = this.nextPlatformEntitySeq(key);
      const { channel, label, partition } = this.platformEntityRequestInfo(row);
      this.$set(this.platformEntityLoading, key, true);
      this.$set(this.platformEntityOptions, key, []);
      try {
        const result = await ipcRenderer.invoke(channel, {
          partition,
          queryString: keyword,
        });
        // 期间用户又改了输入或点了清空：本次结果已过期，丢弃
        if (this.platformEntitySeq[key] !== seq) return;
        if (!result || result.ok !== true) {
          this.$message.warning((result && result.error) || `搜索${label}失败`);
          return;
        }
        this.$set(this.platformEntityOptions, key, result.entities || []);
        this.$set(this.platformEntitySearched, key, true);
      } catch (e) {
        if (this.platformEntitySeq[key] !== seq) return;
        this.$message.error(
          `搜索${label}失败：` + (e && e.message ? e.message : e)
        );
      } finally {
        // 只有仍是最新请求时才收掉 loading
        if (this.platformEntitySeq[key] === seq) {
          this.$set(this.platformEntityLoading, key, false);
        }
      }
    },
    /**
     * 取下一个请求序号（同时作废该 key 上所有在途请求）。
     *
     * 用自增序号而不是关键词做令牌：清空后再输入同一个词时，
     * 关键词会相同、序号不会，过期响应才不会被误认成最新结果。
     *
     * 序号取自**全局单调计数器**（componentSeq），不复用：
     * 若按 key 各自计数，resetPlatformVideoLinks 把 map 清空后计数器会从头开始，
     * 上一次会话遗留的在途响应就可能与新会话撞上同一个号而复活下拉。
     * 全局计数器只增不减，跨会话也不会撞号，故 reset 时无需（也不该）清它。
     */
    nextPlatformEntitySeq(key) {
      this.componentSeq += 1;
      this.$set(this.platformEntitySeq, key, this.componentSeq);
      return this.componentSeq;
    },
    /** 回车：立即触发搜索（不选中；选中只能由用户点选完成） */
    onEntitySearchEnter(row, event) {
      const q = (event && event.target && event.target.value) || "";
      this.searchPlatformEntityOptions(row, q);
    },
    /**
     * 清掉某行的搜索下拉结果与「已搜过」标记。
     * 用于：点 clearable 的 ×、切换挂载类型、以及输入被删空。
     * 必须同时作废在途请求（自增序号），否则清空后旧响应返回会把下拉复活。
     */
    clearPlatformEntityOptions(row) {
      if (!row) return;
      const key = this.entityOptionsKey(row);
      this.nextPlatformEntitySeq(key);
      this.$set(this.platformEntityOptions, key, []);
      this.$set(this.platformEntitySearched, key, false);
      this.$set(this.platformEntityLoading, key, false);
    },
    /**
     * el-select 的 value 变化。
     *
     * @input 有两条来源，必须区分：
     *   1) 用户点选候选项 → 值是剧名，此时**要保留**下拉（便于确认选中的是哪一条）
     *   2) clearable 的 × / 输入被删空 → 值为空，此时**要清掉**下拉，
     *      否则会残留上一次搜索的候选
     * 只按「值为空」判断即可覆盖两种清空路径。
     */
    onEntityValueChange(row, value) {
      const text = String(value == null ? "" : value);
      this.setPlatformVideoLinkValue(row.id, row.pt, text);
      if (!text.trim()) {
        this.clearPlatformEntityOptions(row);
      }
    },
    /**
     * 切换挂载类型时清掉目标类型的缓存，避免沿用上一次（可能是别的账号/别的类型）
     * 的旧列表；短剧与剧集共用同一下拉，不清会串数据。
     */
    clearPlatformEntityCache(row, type) {
      const key = `${row.id}:${type}`;
      // 先自增序号作废在途请求，再清数据；与 clearPlatformEntityOptions 行为一致
      this.nextPlatformEntitySeq(key);
      if (this.platformEntityOptions[key] !== undefined) {
        this.$delete(this.platformEntityOptions, key);
      }
      if (this.platformEntitySearched[key] !== undefined) {
        this.$delete(this.platformEntitySearched, key);
      }
      if (this.platformEntityLoading[key] !== undefined) {
        this.$delete(this.platformEntityLoading, key);
      }
    },
    getPlatformVideoLinkTypeInfo(data) {
      return getVideoLinkTypeCapability(
        data.pt,
        this.getPlatformVideoLinkType(data.id, data.pt)
      );
    },
    platformVideoLinkNeedsValue(data) {
      const info = this.getPlatformVideoLinkTypeInfo(data);
      return Boolean(info && info.inputKind !== "none");
    },
    /** 只有视频号商品使用橱窗接口；抖音 URL / 快手完整商品名独立填写。 */
    platformVideoLinkIsProduct(data) {
      const info = this.getPlatformVideoLinkTypeInfo(data);
      return Boolean(info && info.selectionMode === "product_id");
    },
    platformVideoLinkPlaceholder(data) {
      const info = this.getPlatformVideoLinkTypeInfo(data);
      return (info && info.placeholder) || "请输入编号";
    },
    platformVideoLinkMaxLength(data) {
      const info = this.getPlatformVideoLinkTypeInfo(data);
      return (info && info.maxLength) || 64;
    },
    getPlatformProductOptions(nodeId) {
      return this.platformProductOptions[nodeId] || [];
    },
    async loadPlatformWindowProducts(row, force = false) {
      if (!row || !this.platformVideoLinkIsProduct(row)) return;
      if (
        !force &&
        Array.isArray(this.platformProductOptions[row.id]) &&
        this.platformProductOptions[row.id].length
      ) {
        return;
      }
      if (this.platformProductLoading[row.id]) return;
      const partition = buildAccountPartitionOf(row, row.pt);
      this.$set(this.platformProductLoading, row.id, true);
      try {
        const result = await ipcRenderer.invoke("sph:list-window-products", {
          partition,
        });
        if (!result || result.ok !== true) {
          this.$message.warning((result && result.error) || "拉取橱窗商品失败");
          this.$set(this.platformProductOptions, row.id, []);
          return;
        }
        this.$set(this.platformProductOptions, row.id, result.products || []);
        if (!(result.products || []).length) {
          this.$message.info("橱窗暂无商品，可手动输入商品编号");
        }
      } catch (e) {
        this.$message.error(
          "拉取橱窗商品失败：" + (e && e.message ? e.message : e)
        );
      } finally {
        this.$set(this.platformProductLoading, row.id, false);
      }
    },
    validatePlatformVideoLinks(platforms) {
      for (const platform of platforms || []) {
        if (!platformSupportsVideoLink(platform.pt)) continue;
        const type = this.getPlatformVideoLinkType(platform.id, platform.pt);
        if (!type || type === "none") continue;
        const checked = validateVideoLinkValue(
          platform.pt,
          type,
          this.getPlatformVideoLinkValue(platform.id),
          { shortTitle: this.getPlatformVideoLinkShortTitle(platform.id) }
        );
        if (!checked.ok) {
          return `${platform.phone} ${platform.pt}：${checked.error}`;
        }
      }
      return "";
    },
    getAllPlatformLeafNodes() {
      const leaves = [];
      (this.treeData || []).forEach((group) => {
        (group.children || []).forEach((child) => {
          if (child && child.url) leaves.push(child);
        });
      });
      return leaves;
    },
    initPlatformStatementsForLeaves(leaves, defaultValue) {
      const baseDefault =
        defaultValue !== undefined
          ? defaultValue
          : this.defaultCreativeStatement || DEFAULT_PUBLISH_CREATIVE_STATEMENT;
      const next = { ...this.platformStatements };
      leaves.forEach((node) => {
        if (!next[node.id]) {
          next[node.id] = resolveCreativeStatementForPlatform(
            baseDefault,
            node.pt
          );
        }
      });
      this.platformStatements = next;
    },
    applyRepublishPlatformStatements(fallbackValue) {
      const fallbackBase =
        fallbackValue != null && String(fallbackValue).trim() !== ""
          ? fallbackValue
          : this.defaultCreativeStatement || DEFAULT_PUBLISH_CREATIVE_STATEMENT;
      const next = { ...this.platformStatements };
      this.getAllPlatformLeafNodes().forEach((node) => {
        const rec = this.findRepublishRecord(node.pt, node);
        if (rec && rec.creativeStatement) {
          next[node.id] = resolveCreativeStatementForPlatform(
            rec.creativeStatement,
            node.pt
          );
        } else if (!next[node.id]) {
          next[node.id] = resolveCreativeStatementForPlatform(
            fallbackBase,
            node.pt
          );
        }
      });
      this.platformStatements = next;
    },
    applyRepublishPlatformVideoLinks() {
      const next = { ...this.platformVideoLinks };
      this.getAllPlatformLeafNodes().forEach((node) => {
        const rec = this.findRepublishRecord(node.pt, node);
        const link = resolveVideoLinkOption(node.pt, rec && rec.publishOptions);
        if (link && link.enabled && link.value) {
          next[node.id] = { type: link.type, value: String(link.value), shortTitle: String(link.shortTitle || "") };
        }
      });
      this.platformVideoLinks = next;
    },
    handleCheckAllPlatforms(checked) {
      if (!this.$refs.tree) return;
      const keys = checked
        ? this.getAllPlatformLeafNodes().map((n) => n.id)
        : [];
      this.$refs.tree.setCheckedKeys(keys);
      this.initPlatformStatementsForLeaves(this.getAllPlatformLeafNodes());
      this.onTreeCheck();
    },
    onTreeCheck() {
      if (!this.$refs.tree) return;
      const checkedLeaves = this.$refs.tree
        .getCheckedNodes(true)
        .filter((n) => n && n.url);
      this.checkedPlatformIds = checkedLeaves.map((n) => n.id);
      this.initPlatformStatementsForLeaves(checkedLeaves);
      const allLeaves = this.getAllPlatformLeafNodes();
      const total = allLeaves.length;
      const count = checkedLeaves.length;
      this.checkAllPlatforms = total > 0 && count === total;
      this.checkAllIndeterminate = count > 0 && count < total;
    },
    isPlatformNodeChecked(id) {
      return this.checkedPlatformIds.includes(id);
    },
    getPlatformStatement(id, pt) {
      if (this.platformStatements[id]) {
        return normalizeCreativeStatement(this.platformStatements[id]);
      }
      const fallback =
        this.defaultCreativeStatement || DEFAULT_PUBLISH_CREATIVE_STATEMENT;
      if (pt) {
        return resolveCreativeStatementForPlatform(fallback, pt);
      }
      const leaf = this.getAllPlatformLeafNodes().find((n) => n.id === id);
      if (leaf && leaf.pt) {
        return resolveCreativeStatementForPlatform(fallback, leaf.pt);
      }
      return normalizeCreativeStatement(fallback);
    },
    setPlatformStatement(id, value) {
      this.$set(this.platformStatements, id, normalizeCreativeStatement(value));
    },
    getStatementOptionsForNode(data) {
      return getCreativeStatementOptionsForPlatform(data.pt);
    },
    getStatementOptionPlatformLabel(opt, pt) {
      const key = getCreativeStatementPlatformKey(pt);
      if (key && opt.platformLabels && opt.platformLabels[key]) {
        return opt.platformLabels[key];
      }
      return opt.label;
    },
    getPlatformStatementDisplay(data) {
      return getCreativeStatementShortLabel(
        this.getPlatformStatement(data.id),
        data.pt
      );
    },
    applyBatchCreativeStatement(options = {}) {
      const { silent = false } = options;
      const batchValue = normalizeCreativeStatement(
        this.batchCreativeStatement
      );
      const targets = this.checkedPlatformNodes.filter((node) =>
        platformSupportsCreativeStatement(node.pt)
      );
      if (targets.length === 0) {
        if (!silent)
          this.$message.warning("已勾选账号中没有支持创作声明的平台");
        return;
      }
      const next = { ...this.platformStatements };
      let applied = 0;
      let fallback = 0;
      targets.forEach((node) => {
        const opts = getCreativeStatementOptionsForPlatform(node.pt);
        const matched = opts.find((opt) => opt.value === batchValue);
        if (matched) {
          next[node.id] = matched.value;
          applied += 1;
        } else {
          // 当前批量值在该平台没有对应选项时，回退到「无标注」，
          // 保证每个支持声明的子账号都有一个明确的声明值，不会留空。
          next[node.id] = CREATIVE_STATEMENT_DEFAULT;
          fallback += 1;
        }
      });
      this.platformStatements = next;
      if (applied === 0 && fallback === 0) {
        if (!silent) this.$message.warning("当前批量声明不适用于已勾选平台");
        return;
      }
      if (!silent) {
        if (fallback > 0) {
          this.$message.success(
            `已为 ${applied} 个账号设置创作声明，${fallback} 个不支持已回退为「无标注」`
          );
        } else {
          this.$message.success(`已为 ${applied} 个账号设置创作声明`);
        }
      }
    },
    // 用户点了批量声明下拉的任意选项（包括"二次选中相同值"），
    // 都强制覆盖所有已勾选支持平台账号的声明值。
    onBatchStatementOptionClick(value) {
      this.batchCreativeStatement = normalizeCreativeStatement(value);
      this.applyBatchCreativeStatement({ silent: true });
    },
    isVideohaoPlatform(platform) {
      return String((platform && platform.pt) || "").includes("视频号");
    },
    validatePublishAt() {
      if (!this.scheduledPublish) return "";
      const value = String(this.publishAt || "").trim();
      if (!value) return "请选择定时发布时间";
      const parsed = parsePublishAtUtc8(value, Date.now());
      if (!parsed.ok) return parsed.error;
      return "";
    },
    validateVideohaoBt2(value) {
      return validateVideohaoBt2Value(value);
    },
    warnBt2SpecialPunctuation() {
      this.$message.warning("概括短标题不能包含特殊标点符号");
    },
    onBt2Input(value) {
      const nextValue = sanitizeVideohaoBt2Input(value);
      if (nextValue === value) return;
      this.form.shortTitle = nextValue;
      this.warnBt2SpecialPunctuation();
    },
    onBt2Keydown(e) {
      if (isBt2SelectAllShortcut(e)) {
        const target = e.target;
        if (target && typeof target.select === "function") {
          e.preventDefault();
          e.stopPropagation();
          target.select();
        }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const key = String(e.key || "");
      if (key.length !== 1 || isVideohaoBt2AllowedChar(key)) return;
      e.preventDefault();
      e.stopPropagation();
      this.warnBt2SpecialPunctuation();
    },

    async onMetaNext() {
      if (!this.localFilePath) {
        this.$message.warning("请先点击选择或拖入视频文件");
        return;
      }
      if (!this.form.bt1 || !this.form.bt1.trim()) {
        this.$message.warning("请填写标题");
        return;
      }
      const nextBt2 = sanitizeVideohaoBt2Input(this.form.shortTitle);
      if (nextBt2 !== this.form.shortTitle) {
        this.form.shortTitle = nextBt2;
        this.warnBt2SpecialPunctuation();
        return;
      }
      const publishAtError = this.validatePublishAt();
      if (publishAtError) {
        this.$message.warning(publishAtError);
        return;
      }
      await this.loadPublishThrottleDefaults();
      this.loadAccounts();
      this.metaVisible = false;
      this.platformVisible = true;
      this.$nextTick(() => {
        this.resetPlatformStatementState();
        this.initPlatformStatementsForLeaves(this.getAllPlatformLeafNodes());
        if (this.$refs.tree) {
          this.$refs.tree.setCheckedKeys([]);
        }
        this.onTreeCheck();
      });
    },
    goBackToMeta() {
      this.platformVisible = false;
      this.attrsVisible = false;
      this.metaVisible = true;
    },
    onPlatformNext() {
      const platforms = this.checkedPlatformNodes;
      if (!platforms.length) {
        this.$message.warning("请至少选择一个平台");
        return;
      }
      const dySyncConflict = this.validateDySyncToutiaoConflict(platforms);
      if (dySyncConflict) {
        this.$message.warning(dySyncConflict);
        return;
      }
      // 先打开第 3 步，再关第 2 步，避免 platform close 误触发 resetState
      this.attrsVisible = true;
      this.platformVisible = false;
      this.$nextTick(() => {
        platforms
          .filter((node) => platformSupportsVideoLink(node.pt))
          .forEach((node) => {
            if (this.getPlatformVideoLinkType(node.id, node.pt) === "product") {
              this.loadPlatformWindowProducts(node);
            }
            // 短剧/剧集不预取：初始下拉为空，等用户输入回车再搜索
          });
      });
    },
    goBackToPlatform() {
      this.platformVisible = true;
      this.attrsVisible = false;
    },

    handleMetaClose() {
      if (!this.platformVisible && !this.attrsVisible) {
        this.resetState();
      }
    },

    handlePlatformClose() {
      if (!this.metaVisible && !this.attrsVisible) {
        this.resetState();
      }
    },
    handleAttrsClose() {
      if (!this.metaVisible && !this.platformVisible) {
        this.resetState();
      }
    },

    resetState() {
      this.localFilePath = "";
      this.bqTags = [];
      this.bqComposing = false;
      this.resetPlatformStatementState();
      this.resetPlatformVideoLinks();
      this.resetPlatformCollections();
      this.form = {
        title: "",
        bt1: "",
        description: "",
        shortTitle: "",
        titleByPlatform: {},
        coverPath: "",
        coverPathH: "",
        noDownload: false,
        dySyncToutiao: readDySyncToutiaoPreference(),
      };
      this.thisShow = false;
      this.closeWindow = true;
      this.scheduledPublish = false;
      this.publishAt = "";
      this.republishContext = null;
      this.republishTextOtherName = "";
      this.dirBatchFiles = [];
      this.attrsVisible = false;
    },

    loadAccounts() {
      try {
        const raw = localStorage.getItem("accountTree");
        const parsed = raw ? JSON.parse(raw) : {};
        this.treeData = this.formatAccountTree(parsed);
      } catch (e) {
        this.treeData = [];
        console.error("账号树加载失败", e);
      }
    },

    formatAccountTree(rawTree) {
      return Object.keys(rawTree).map((phone) => {
        const node = rawTree[phone];
        return {
          id: phone,
          title: phone,
          children: (node.children || []).map((child) => ({
            id: child.meta.id,
            pt: child.meta.pt,
            // phone 保留完整记录值；分组/账号名/登录主键按新分组模型透传
            phone: child.meta.phone,
            group: recordGroupOf(child.meta),
            accountName: recordAccountNameOf(child.meta),
            accountKey: recordAccountKeyOf(child.meta),
            date: child.meta.date,
            url: child.meta.url,
            // 透传账号"默认发布到草稿"设置，让 resolveEffectivePublishMode 能识别
            defaultPublishToDraft: Boolean(child.meta.defaultPublishToDraft),
            // 透传"使用真实浏览器"设置，让 puppeteerFile 走本地 Chrome 自动化
            useRealBrowser: Boolean(child.meta.useRealBrowser),
            proxyDisplay: getAccountProxyDisplay(child.meta.proxy),
            proxyEnabled: isAccountProxyEnabled(child.meta.proxy),
            loggedIn: (() => {
              const name = accountLoginFlagNameOf(child.meta, child.meta.pt);
              if (isAccountLoginFlagSet(name)) return true;
              const cookies = document.cookie.split(";");
              for (const c of cookies) {
                const [key, value] = c.trim().split("=");
                if (key == name && value == "true") return true;
              }
              return false;
            })(),
          })),
        };
      });
    },

    verifyLogin(parent) {
      const children = parent.children || [];
      children.forEach((child) => {
        this.checkLoginStatus(child);
      });
    },

    checkLoginStatus(i) {
      const taskId = Date.now() + Math.random();
      const partition = buildAccountPartitionOf(i, i.pt);
      ipcRenderer.send("getCookie", {
        taskId,
        partition,
        url: i.url,
        pt: i.pt,
        name: accountLoginFlagNameOf(i, i.pt),
      });
      this.taskHandlers.set(taskId, (data) => {
        const flagName = data.flagName || accountLoginFlagNameOf(i, i.pt);
        if (data.success) {
          if (data.result) {
            setAccountLoginFlag(flagName, data.loginExpiresAtMs);
            try {
              document.cookie = data.result;
            } catch (e) {
              /* file:// 打包页面对 document.cookie 限制严格，已用 localStorage */
            }
          } else {
            clearAccountLoginFlag(flagName);
          }
        } else {
          clearAccountLoginFlag(flagName);
          console.error(
            `[${recordAccountKeyOf(i)}${i.pt}] 登录状态失败:`,
            data.error
          );
        }
      });
      setTimeout(() => {
        this.loadAccounts();
      }, 1000);
    },

    hideLoginDialog() {
      this.showLoginDialog = false;
      setTimeout(() => {
        this.loadAccounts();
      }, 1000);
    },

    async reLogin(item) {
      const partition = buildAccountPartitionOf(item, item.pt);
      try {
        const result = await openLoginWindow({ ...item, partition });
        if (result && result.ok === false) {
          this.$message.error(result.message || "打开登录窗口失败");
        } else if (result && result.reused) {
          this.$message.info("已切换到已打开的登录窗口");
        }
      } catch (e) {
        this.$message.error(
          "打开登录窗口失败：" + (e && e.message ? e.message : e)
        );
      }
      // 旧逻辑里 hideLoginDialog 会在 dialog 关闭后调 loadAccounts；
      // 这里手动延时调一次，让 cookie 落地后刷新登录状态。
      setTimeout(() => {
        if (typeof this.loadAccounts === "function") this.loadAccounts();
      }, 2000);
    },

    async handleBatchPublish() {
      return this.submitBatchPublish("publish");
    },

    async handleBatchPublishToDraft() {
      return this.submitBatchPublish("draft");
    },

    async submitBatchPublish(mode = "publish") {
      if (this.publishing) return;
      this.publishing = true;
      try {
        return await this.doSubmitBatchPublish(mode);
      } finally {
        this.publishing = false;
      }
    },

    async doSubmitBatchPublish(mode = "publish") {
      const isDraftMode = mode === "draft";
      // Directory batch mode
      if (this.dirBatchFiles && this.dirBatchFiles.length > 0) {
        return this.submitDirBatchPublish(mode);
      }
      if (!this.localFilePath) {
        this.$message.warning("未选择视频文件");
        return;
      }
      const checked = this.$refs.tree.getCheckedNodes(true);
      const platforms = checked.filter((item) => item.url);
      if (platforms.length === 0) {
        this.$message.warning("请至少选择一个平台");
        return;
      }
      const dySyncConflict = this.validateDySyncToutiaoConflict(platforms);
      if (dySyncConflict) {
        this.$message.warning(dySyncConflict);
        return;
      }
      const linkError = this.validatePlatformVideoLinks(platforms);
      if (linkError) {
        this.$message.warning(linkError);
        return;
      }
      if (
        isDraftMode &&
        platforms.some((p) => String(p.pt || "").includes("头条"))
      ) {
        this.$message.warning("暂无头条草稿");
        return;
      }
      if (isDraftMode && this.scheduledPublish) {
        this.$message.warning("发布到草稿不支持定时发布，请关闭定时发布后再试");
        return;
      }
      const hasVideohao = platforms.some(this.isVideohaoPlatform);
      if (hasVideohao && this.form.shortTitle && this.form.shortTitle.trim()) {
        // 仅当用户填写了短标题时才校验规则（6～16 字、无特殊标点）
        const bt2Error = this.validateVideohaoBt2(this.form.shortTitle);
        if (bt2Error) {
          this.$message.warning(bt2Error);
          return;
        }
      }
      if (!isDraftMode) {
        const publishAtError = this.validatePublishAt();
        if (publishAtError) {
          this.$message.warning(publishAtError);
          return;
        }
      }
      const coverError = this.validateCoverPath(
        this.form.coverPath,
        platforms.map((p) => p.pt)
      );
      if (coverError) {
        this.$message.error(coverError);
        return;
      }
      const coverHError = this.validateCoverPath(
        this.form.coverPathH,
        platforms.map((p) => p.pt),
        "横版封面"
      );
      if (coverHError) {
        this.$message.error(coverHError);
        return;
      }
      const baseVideo = this.buildVideoPayload();
      const selectedFile = fileBaseName(this.localFilePath);
      const currentDate = moment().format("YYYY-MM-DD");
      const scheduledAtText = String(this.publishAt || "").trim();
      const parsedScheduledAt = this.scheduledPublish
        ? parsePublishAtUtc8(scheduledAtText, Date.now())
        : null;
      const scheduledAtMs =
        parsedScheduledAt && parsedScheduledAt.ok
          ? parsedScheduledAt.value
          : null;
      let submitted = 0;
      let draftSubmitted = 0;
      let scheduledSubmitted = 0;
      const writeErrors = [];

      platforms.sort((a, b) => {
        if (a.pt.includes("视频号")) return -1;
        if (b.pt.includes("视频号")) return 1;
        return 0;
      });

      const resolvePreviewTitleForPlatform = (pt) => {
        const ruled = this.resolvePlatformRulePayload(pt, baseVideo.data, {
          log: false,
        });
        return (ruled && ruled.title) || baseVideo.data.title || baseVideo.bookName;
      };

      const dupCheckTargets = platforms.map((p) => ({
        pt: p.pt,
        phone: p.phone,
        accountKey: p.accountKey,
        partition: buildAccountPartitionOf(p, p.pt),
        title: resolvePreviewTitleForPlatform(p.pt),
      }));
      const dupDecision = await this.confirmDuplicatePublishTargets(dupCheckTargets);
      if (!dupDecision.proceed) {
        return;
      }

      let throttleDecision = {
        proceed: true,
        noThrottle: true,
        itemsByKey: new Map(),
        reservationIds: [],
      };
      if (!isDraftMode) {
        const planEntries = platforms.map((p, idx) => {
          const effectiveMode = resolveEffectivePublishMode(isDraftMode, p);
          return {
            key: `single:${idx}:${p.id}`,
            pt: p.pt,
            phone: p.phone,
            accountKey: p.accountKey,
            partition: buildAccountPartitionOf(p, p.pt),
            filePath: this.localFilePath,
            textType: "local",
            title: resolvePreviewTitleForPlatform(p.pt),
            isDraft: effectiveMode.publishToDraft,
          };
        });
        throttleDecision = await this.confirmThrottlePublishPlan(planEntries, {
          publishAt: this.scheduledPublish ? scheduledAtText : null,
          publishAtMs: scheduledAtMs,
        });
        if (!throttleDecision.proceed) {
          return;
        }
      }

      const scheduledWriteTasks = [];
      for (let idx = 0; idx < platforms.length; idx++) {
        const p = platforms[idx];
        const partition = buildAccountPartitionOf(p, p.pt);
        const taskId = Date.now() + Math.random();
        const shouldShow = this.thisShow;
        const shouldCloseWindowAfterPublish = shouldShow
          ? this.closeWindow
          : true;
        const video = this.buildPlatformVideoPayload(p, baseVideo);
        const effectiveMode = resolveEffectivePublishMode(isDraftMode, p);
        const planItem = throttleDecision.itemsByKey.get(`single:${idx}:${p.id}`);
        const itemReservationId =
          !effectiveMode.publishToDraft && planItem && planItem.reservationId
            ? planItem.reservationId
            : null;
        const shouldSchedule =
          !effectiveMode.publishToDraft &&
          (planItem ? Boolean(planItem.scheduled) : this.scheduledPublish);
        if (shouldSchedule) {
          const itemScheduledAtMs =
            planItem && planItem.scheduled
              ? planItem.plannedAtMs
              : scheduledAtMs;
          const itemScheduledAtText =
            planItem && planItem.scheduled
              ? planItem.publishAt
              : scheduledAtText;
          const itemThrottleReason =
            (!throttleDecision.noThrottle && planItem && planItem.reason) || "";
          scheduledWriteTasks.push(
            this.writeScheduledPublishRecord(
              {
                bookName: video.bookName,
                textOtherName: video.data.textOtherName,
                textType: video.textType,
                pt: p.pt,
                selectedFile,
                bt: video.data.bt1,
                title: video.data.title,
                description: video.data.description,
                shortTitle: video.data.shortTitle,
                tags: video.data.tags,
                bt2: video.data.bt2,
                bt2Filled: video.data.bt2Filled,
                bdText: video.data.bdText,
                bq: video.data.bq,
                creativeStatement: video.data.creativeStatement,
                noDownload: video.data.noDownload === true,
                publishOptions: video.publishOptions,
                coverPath: video.data.coverPath || "",
                ...(video.data.coverPathH
                  ? { coverPathH: video.data.coverPathH }
                  : {}),
                ...(Array.isArray(video.data.ruleAdjustments) &&
                video.data.ruleAdjustments.length > 0
                  ? {
                      ruleAdjustments: video.data.ruleAdjustments,
                      ruleAdjustmentsSummary: video.data.ruleAdjustmentsSummary,
                    }
                  : {}),
                filePath: this.localFilePath,
                useragent: this.ptConfig[p.pt].useragent,
                phone: p.phone,
                group: p.group,
                accountName: p.accountName,
                accountKey: p.accountKey,
                partition,
                url: this.ptConfig[p.pt].listIndex,
                uploadUrl: this.ptConfig[p.pt].upload,
                date: currentDate,
                scheduledTask: true,
                ...(dupDecision.allowDuplicate ? { allowDuplicate: true } : {}),
                ...(itemThrottleReason
                  ? { throttleReason: itemThrottleReason }
                  : {}),
                scheduledPublishAt: itemScheduledAtMs,
                scheduledPublishAtText: itemScheduledAtText,
                useRealBrowser: Boolean(p.useRealBrowser),
                publishAttemptCount: 1,
                republishCount: 0,
                publishSuccessCount: 0,
                publishFailCount: 0,
                publishMode: effectiveMode.publishMode,
                publishToDraft: effectiveMode.publishToDraft,
                publishStatus: "scheduled",
                lastPublishMessage: itemThrottleReason
                  ? `等待定时发布（${itemThrottleReason}）`
                  : "等待定时发布",
                lastPublishAt: Date.now(),
              },
              itemReservationId
            )
          );
          continue;
        }
        // 先写 pushData，确认落盘成功再提交上传（写盘失败时释放预留并报错）
        const republishRecord = this.findRepublishRecord(p.pt, p);
        let pushRes;
        let persistedRecordId = null;
        try {
          if (republishRecord && republishRecord.id && republishRecord.date) {
            const oldAttempt = Number(republishRecord.publishAttemptCount) || 1;
            let oldRepublish = Number(republishRecord.republishCount);
            if (!Number.isFinite(oldRepublish) || oldRepublish < 0) {
              oldRepublish = Math.max(0, oldAttempt - 1);
            }
            pushRes = await dataRequest({
              type: "update",
              fileName: "pushData",
              item: {
                id: republishRecord.id,
                date: republishRecord.date,
                bookName: video.bookName,
                textOtherName: video.data.textOtherName,
                selectedFile,
                bt: video.data.bt1,
                title: video.data.title,
                description: video.data.description,
                shortTitle: video.data.shortTitle,
                tags: video.data.tags,
                bt2: video.data.bt2,
                bt2Filled: video.data.bt2Filled,
                bdText: video.data.bdText,
                bq: video.data.bq,
                creativeStatement: video.data.creativeStatement,
                noDownload: video.data.noDownload === true,
                publishOptions: video.publishOptions,
                coverPath: video.data.coverPath || "",
                ...(video.data.coverPathH
                  ? { coverPathH: video.data.coverPathH }
                  : {}),
                ...(Array.isArray(video.data.ruleAdjustments) &&
                video.data.ruleAdjustments.length > 0
                  ? {
                      ruleAdjustments: video.data.ruleAdjustments,
                      ruleAdjustmentsSummary: video.data.ruleAdjustmentsSummary,
                    }
                  : {}),
                filePath: this.localFilePath,
                publishAttemptCount: oldAttempt + 1,
                republishCount: oldRepublish + 1,
                publishMode: effectiveMode.publishMode,
                publishToDraft: effectiveMode.publishToDraft,
                publishStatus: effectiveMode.publishToDraft
                  ? "drafting"
                  : "publishing",
                lastPublishMessage: effectiveMode.publishToDraft
                  ? "等待保存草稿结果"
                  : "等待发布结果",
                lastPublishAt: Date.now(),
              },
            });
            persistedRecordId = republishRecord.id;
          } else {
            pushRes = await dataRequest({
              type: "add",
              fileName: "pushData",
              item: {
                bookName: video.bookName,
                textOtherName: video.data.textOtherName,
                textType: video.textType,
                pt: p.pt,
                selectedFile,
                bt: video.data.bt1,
                title: video.data.title,
                description: video.data.description,
                shortTitle: video.data.shortTitle,
                tags: video.data.tags,
                bt2: video.data.bt2,
                bt2Filled: video.data.bt2Filled,
                bdText: video.data.bdText,
                bq: video.data.bq,
                creativeStatement: video.data.creativeStatement,
                noDownload: video.data.noDownload === true,
                publishOptions: video.publishOptions,
                coverPath: video.data.coverPath || "",
                ...(video.data.coverPathH
                  ? { coverPathH: video.data.coverPathH }
                  : {}),
                ...(Array.isArray(video.data.ruleAdjustments) &&
                video.data.ruleAdjustments.length > 0
                  ? {
                      ruleAdjustments: video.data.ruleAdjustments,
                      ruleAdjustmentsSummary: video.data.ruleAdjustmentsSummary,
                    }
                  : {}),
                filePath: this.localFilePath,
                useragent: this.ptConfig[p.pt].useragent,
                phone: p.phone,
                group: p.group,
                accountName: p.accountName,
                accountKey: p.accountKey,
                partition,
                url: this.ptConfig[p.pt].listIndex,
                date: currentDate,
                useRealBrowser: Boolean(p.useRealBrowser),
                publishMode: effectiveMode.publishMode,
                publishToDraft: effectiveMode.publishToDraft,
                publishAttemptCount: 1,
                republishCount: 0,
                publishSuccessCount: 0,
                publishFailCount: 0,
                publishStatus: effectiveMode.publishToDraft
                  ? "drafting"
                  : "publishing",
                lastPublishMessage: effectiveMode.publishToDraft
                  ? "等待保存草稿结果"
                  : "等待发布结果",
                lastPublishAt: Date.now(),
              },
            });
            if (pushRes && pushRes.success && Array.isArray(pushRes.data)) {
              const found = [...pushRes.data]
                .reverse()
                .find(
                  (it) =>
                    it.textOtherName === video.data.textOtherName &&
                    it.pt === p.pt &&
                    it.selectedFile === selectedFile &&
                    String(it.partition || "") === String(partition || "")
                );
              if (found) persistedRecordId = found.id;
            }
          }
        } catch (e) {
          pushRes = { success: false, message: (e && e.message) || String(e) };
        }
        if (pushRes && pushRes.success === false) {
          if (itemReservationId) {
            await this.releaseThrottleReservations([itemReservationId]);
          }
          writeErrors.push(
            `${p.pt} 写入发布记录失败：${pushRes.message || "未知错误"}`
          );
          continue;
        }
        if (
          itemReservationId &&
          ipcRenderer &&
          typeof ipcRenderer.invoke === "function"
        ) {
          try {
            await ipcRenderer.invoke("publish-throttle:confirm-reservation", {
              reservationId: itemReservationId,
              status: "publishing",
              recordId: persistedRecordId,
              ts: Date.now(),
              isScheduled: false,
            });
          } catch (_) {}
        }

        // 用 JSON 兜底序列化，去掉 Vue 响应式代理 / 不可克隆对象，
        // 避免 Electron IPC 抛 "object could not be cloned" 导致页面会话提前关闭。
        const publishPayload = applyXhsConservativePublishOptions({
          ...p,
          taskId,
          allowDuplicate: true,
          ...(persistedRecordId != null ? { recordId: persistedRecordId } : {}),
          ...(itemReservationId
            ? { throttleReservationId: itemReservationId }
            : {}),
          ...video,
          textOtherName: video.data.textOtherName,
          selectedFile,
          publishMode: effectiveMode.publishMode,
          publishToDraft: effectiveMode.publishToDraft,
          url: this.ptConfig[p.pt].upload,
          show: shouldShow,
          closeWindowAfterPublish: shouldCloseWindowAfterPublish,
          useragent: this.ptConfig[p.pt].useragent,
          partition,
          filePath: this.localFilePath,
          date: currentDate,
        });
        ipcRenderer.send(
          "puppeteerFile",
          JSON.parse(JSON.stringify(publishPayload))
        );

        if (isXhsPlatform(p.pt)) {
          await sleep(getXhsPlatformStaggerDelayMs());
        } else if (p.pt === "视频号") {
          await sleep(4000);
        }
        submitted++;
        if (effectiveMode.publishToDraft) draftSubmitted++;
      }

      if (scheduledWriteTasks.length > 0) {
        const writeResults = await Promise.all(scheduledWriteTasks);
        for (const r of writeResults) {
          if (r && (r.ok === true || r.success === true)) {
            submitted++;
            scheduledSubmitted++;
          } else {
            writeErrors.push(
              (r && (r.message || r.error)) || "写入定时发布记录失败"
            );
          }
        }
        if (scheduledSubmitted > 0) {
          ipcRenderer.send("scheduledPublish:refresh");
        }
      }
      if (writeErrors.length > 0) {
        this.$message.error(writeErrors.join("；"));
      }
      if (submitted === 0) {
        if (writeErrors.length === 0) {
          this.$message.warning("没有提交新的发布任务");
        }
        return;
      }
      let successMessage = `已提交 ${submitted} 个平台发布`;
      if (draftSubmitted === submitted) {
        successMessage = `已提交 ${submitted} 个平台保存草稿`;
      } else if (scheduledSubmitted === submitted) {
        successMessage = `已创建 ${submitted} 个平台定时发布任务`;
      } else if (scheduledSubmitted > 0) {
        const immediateCount = submitted - scheduledSubmitted;
        successMessage = `已提交 ${immediateCount} 个平台立即发布，${scheduledSubmitted} 个平台已按节流排期定时发布`;
      }
      this.$message.success(successMessage);
      this.attrsVisible = false;
      this.platformVisible = false;
      this.resetState();
      this.$emit("published");
    },

    openDirectory() {
      this.dirPath = "";
      this.dirXlsxRows = [];
      this.dirXlsxError = "";
      this.republishContext = null;
      this.republishTextOtherName = "";
      this.resetPlatformVideoLinks();
      this.resetPlatformCollections();
      if (this.form) {
        this.form.dySyncToutiao = readDySyncToutiaoPreference();
      }
      this.scheduledPublish = false;
      this.publishAt = "";
      this.dirPublishVisible = true;
    },

    handleDirPublishClose() {
      this.dirPath = "";
      this.dirXlsxRows = [];
      this.dirXlsxError = "";
    },

    async chooseBatchDir() {
      const result = await ipcRenderer.invoke("dialog:openBatchDir");
      if (result) {
        this.dirPath = result;
      }
    },

    async chooseBatchXlsx() {
      const result = await ipcRenderer.invoke("dialog:openBatchXlsx");
      if (!result) return;
      if (result.error) {
        this.dirXlsxError = "xlsx 解析失败: " + result.error;
        this.dirXlsxRows = [];
        return;
      }
      this.dirXlsxError = "";
      this.dirXlsxRows = result;
    },

    async downloadBatchTemplate() {
      const result = await ipcRenderer.invoke("dialog:downloadBatchTemplate");
      if (result && result.ok) {
        this.$message.success("模版已下载到: " + result.path);
      } else {
        this.$message.error(
          "模版下载失败: " +
            (result && result.error ? result.error : "未知错误")
        );
      }
    },

    dirFileExists(fileName) {
      // We can only check existence via the path we have; actual fs check is main-process side.
      // For display purposes: just show true if dirPath is set (we trust the user).
      // A proper check would require another IPC call which is overkill for a preview indicator.
      // Simple heuristic: always show checkmark if dirPath is set, since we can't do fs from renderer.
      return !!this.dirPath;
    },

    async onDirPublishNext() {
      if (!this.dirPath) {
        this.$message.warning("请先选择目录");
        return;
      }
      if (!this.dirXlsxRows.length) {
        this.$message.warning("请先选择声明文件");
        return;
      }
      const publishAtError = this.validatePublishAt();
      if (publishAtError) {
        this.$message.warning(publishAtError);
        return;
      }
      // Filter rows to only those with a fileName
      const filteredRows = this.dirXlsxRows.filter(
        (r) => r.fileName && r.fileName.trim()
      );
      if (!filteredRows.length) {
        this.$message.warning("xlsx 中没有有效的文件名行");
        return;
      }

      // 用 main 进程对每个 fileName 做："文件存在性 + 后缀自动补全 + 大小写匹配"
      // 任意一条匹配不到都直接阻断，避免发布时拿着不存在的 filePath 卡死。
      const resolveRes = await ipcRenderer.invoke("resolveBatchFiles", {
        dirPath: this.dirPath,
        fileNames: filteredRows.map((r) => r.fileName),
      });
      if (!resolveRes || resolveRes.error) {
        this.$message.error(
          "校验文件失败: " + ((resolveRes && resolveRes.error) || "未知错误")
        );
        return;
      }
      const missing = resolveRes.results.filter((r) => !r.exists);
      if (missing.length) {
        this.$message.error(
          `以下文件在目录中不存在（前 5 个）: ${missing
            .slice(0, 5)
            .map((m) => m.fileName)
            .join("、")}${
            missing.length > 5 ? ` 等共 ${missing.length} 个` : ""
          }`
        );
        return;
      }
      // 把解析后的完整 filePath 回填到 dirBatchFiles，submitDirBatchPublish 不再做 path.join。
      const pathToByName = new Map(
        resolveRes.results.map((r) => [r.fileName, r])
      );

      // 封面解析：绝对路径直接用；相对路径相对视频目录。无效路径直接阻断，
      // 与 resolveBatchFiles「任何一条匹配不到都不发」同一策略。
      const fs = require("fs");
      const nodePath = require("path");
      const coverErrors = [];
      const coverHErrors = [];
      const coverResolvedByRow = new Map();
      const coverHResolvedByRow = new Map();
      filteredRows.forEach((row) => {
        const raw = String(row.coverPath || "").trim();
        if (raw) {
          const abs = nodePath.isAbsolute(raw)
            ? raw
            : nodePath.join(this.dirPath, raw);
          let ok = false;
          try {
            ok = fs.statSync(abs).isFile();
          } catch (_) {
            ok = false;
          }
          if (!ok) {
            coverErrors.push(`${row.fileName}: ${abs}`);
          } else {
            coverResolvedByRow.set(row.fileName, abs);
          }
        }
        const rawH = String(row.coverPathH || "").trim();
        if (rawH) {
          const absH = nodePath.isAbsolute(rawH)
            ? rawH
            : nodePath.join(this.dirPath, rawH);
          let okH = false;
          try {
            okH = fs.statSync(absH).isFile();
          } catch (_) {
            okH = false;
          }
          if (!okH) {
            coverHErrors.push(`${row.fileName}: ${absH}`);
          } else {
            coverHResolvedByRow.set(row.fileName, absH);
          }
        }
      });
      if (coverErrors.length) {
        this.$message.error(
          `封面文件不存在（前 5 个）: ${coverErrors.slice(0, 5).join("；")}${
            coverErrors.length > 5 ? ` 等共 ${coverErrors.length} 个` : ""
          }`
        );
        return;
      }
      if (coverHErrors.length) {
        this.$message.error(
          `横版封面文件不存在（前 5 个）: ${coverHErrors
            .slice(0, 5)
            .join("；")}${
            coverHErrors.length > 5 ? ` 等共 ${coverHErrors.length} 个` : ""
          }`
        );
        return;
      }

      this.dirBatchFiles = filteredRows.map((row) => {
        const resolved = pathToByName.get(row.fileName);
        return {
          ...row,
          fileName: resolved
            ? resolved.matchedFileName || row.fileName
            : row.fileName,
          resolvedPath: resolved ? resolved.resolvedPath : "",
          coverResolved: coverResolvedByRow.get(row.fileName) || "",
          coverHResolved: coverHResolvedByRow.get(row.fileName) || "",
        };
      });

      await this.loadPublishThrottleDefaults();
      this.dirPublishVisible = false;
      this.loadAccounts();
      this.platformVisible = true;
      this.$nextTick(() => {
        this.resetPlatformStatementState();
        this.initPlatformStatementsForLeaves(this.getAllPlatformLeafNodes());
        if (this.$refs.tree) {
          this.$refs.tree.setCheckedKeys([]);
        }
        this.onTreeCheck();
      });
    },

    async submitDirBatchPublish(mode = "publish") {
      const isDraftMode = mode === "draft";
      const checked = this.$refs.tree.getCheckedNodes(true);
      const platforms = checked.filter((item) => item.url);
      if (platforms.length === 0) {
        this.$message.warning("请至少选择一个平台");
        return;
      }
      const dySyncConflict = this.validateDySyncToutiaoConflict(platforms);
      if (dySyncConflict) {
        this.$message.warning(dySyncConflict);
        return;
      }
      // 目录批量尚未传递账号级挂车参数，显式阻断，不能静默丢弃后裸发。
      if (platforms.some((row) =>
        /抖音|快手/.test(String(row.pt || "")) &&
        this.getPlatformVideoLinkType(row.id, row.pt) !== "none"
      )) {
        this.$message.warning("目录批量暂不支持抖音/快手商品挂载，请改用单视频发布，或明确选择「无」后重试");
        return;
      }
      if (
        isDraftMode &&
        platforms.some((p) => String(p.pt || "").includes("头条"))
      ) {
        this.$message.warning("暂无头条草稿");
        return;
      }
      if (isDraftMode && this.scheduledPublish) {
        this.$message.warning("发布到草稿不支持定时发布，请关闭定时发布后再试");
        return;
      }
      const hasVideohao = platforms.some(this.isVideohaoPlatform);
      if (hasVideohao) {
        const badCoverRow = this.dirBatchFiles.find(
          (r) => r.coverResolved && !/\.(jpe?g|png)$/i.test(r.coverResolved)
        );
        if (badCoverRow) {
          this.$message.error(
            `视频号封面仅支持 jpg/png 格式（文件 ${badCoverRow.fileName}）: ${badCoverRow.coverResolved}`
          );
          return;
        }
        const badCoverHRow = this.dirBatchFiles.find(
          (r) => r.coverHResolved && !/\.(jpe?g|png)$/i.test(r.coverHResolved)
        );
        if (badCoverHRow) {
          this.$message.error(
            `视频号横版封面仅支持 jpg/png 格式（文件 ${badCoverHRow.fileName}）: ${badCoverHRow.coverHResolved}`
          );
          return;
        }
      }

      const currentDate = moment().format("YYYY-MM-DD");
      const scheduledAtText = String(this.publishAt || "").trim();
      const parsedScheduledAt = this.scheduledPublish
        ? parsePublishAtUtc8(scheduledAtText, Date.now())
        : null;
      const scheduledAtMs =
        parsedScheduledAt && parsedScheduledAt.ok
          ? parsedScheduledAt.value
          : null;

      const path = require("path");
      let submitted = 0;
      let draftSubmitted = 0;
      let scheduledSubmitted = 0;
      const scheduledWriteTasks = [];
      const writeErrors = [];

      platforms.sort((a, b) => {
        if (a.pt.includes("视频号")) return -1;
        if (b.pt.includes("视频号")) return 1;
        return 0;
      });

      const resolveDirRowTitleForPlatform = (fileRow, pt) => {
        const stem = fileRow.fileName.replace(/\.[^/.]+$/, "");
        const baseTitle = sanitizeTitle(fileRow.title) || stem;
        const ruled = safeApplyPlatformRules(
          pt,
          {
            title: baseTitle,
            description: sanitizeDescription(fileRow.description),
            tags: splitAndSanitizeTags(fileRow.tags),
            titleByPlatform: fileRow.titleByPlatform || {},
            descByPlatform: fileRow.descByPlatform || {},
          },
          { log: false }
        );
        return (ruled && ruled.title) || baseTitle;
      };

      const dirDupTargets = [];
      for (const fileRow of this.dirBatchFiles) {
        for (const p of platforms) {
          dirDupTargets.push({
            pt: p.pt,
            phone: p.phone,
            accountKey: p.accountKey,
            partition: buildAccountPartitionOf(p, p.pt),
            title: resolveDirRowTitleForPlatform(fileRow, p.pt),
          });
        }
      }
      const dirDupDecision = await this.confirmDuplicatePublishTargets(dirDupTargets);
      if (!dirDupDecision.proceed) {
        return;
      }

      let dirThrottleDecision = {
        proceed: true,
        noThrottle: true,
        itemsByKey: new Map(),
        reservationIds: [],
      };
      if (!isDraftMode) {
        const dirPlanEntries = [];
        for (let rIdx = 0; rIdx < this.dirBatchFiles.length; rIdx++) {
          const fileRow = this.dirBatchFiles[rIdx];
          const rowFilePath =
            fileRow.resolvedPath || path.join(this.dirPath, fileRow.fileName);
          for (let pIdx = 0; pIdx < platforms.length; pIdx++) {
            const p = platforms[pIdx];
            const effectiveMode = resolveEffectivePublishMode(isDraftMode, p);
            dirPlanEntries.push({
              key: `dir:${rIdx}:${pIdx}:${p.id}`,
              pt: p.pt,
              phone: p.phone,
              accountKey: p.accountKey,
              partition: buildAccountPartitionOf(p, p.pt),
              filePath: rowFilePath,
              textType: "local",
              title: resolveDirRowTitleForPlatform(fileRow, p.pt),
              isDraft: effectiveMode.publishToDraft,
            });
          }
        }
        dirThrottleDecision = await this.confirmThrottlePublishPlan(
          dirPlanEntries,
          {
            publishAt: this.scheduledPublish ? scheduledAtText : null,
            publishAtMs: scheduledAtMs,
          }
        );
        if (!dirThrottleDecision.proceed) {
          return;
        }
      }

      for (let rIdx = 0; rIdx < this.dirBatchFiles.length; rIdx++) {
        const fileRow = this.dirBatchFiles[rIdx];
        // 优先使用 onDirPublishNext 里 IPC 解析好的真实路径（已做存在性 + 后缀补全）。
        // 兜底：老入口或刷新后 resolvedPath 丢失时，回退到 dirPath + fileName 拼接。
        const filePath =
          fileRow.resolvedPath || path.join(this.dirPath, fileRow.fileName);
        const stem = fileRow.fileName.replace(/\.[^/.]+$/, "");
        const bt1 = sanitizeTitle(fileRow.title) || stem;
        const description = sanitizeDescription(fileRow.description);
        const shortTitle = sanitizeTitle(fileRow.shortTitle);
        // 标签统一走共享 splitAndSanitizeTags（与 CLI / HTTP 保持完全一致）
        const tagList = splitAndSanitizeTags(fileRow.tags);
        const bookName = bt1;
        const selectedFile = fileRow.fileName;
        const textOtherName = stem;

        // 视频号短标题非必填；仅校验 xlsx 中显式填写的值。
        const bt2FilledForVideohao = (() => {
          if (!hasVideohao || !shortTitle) return "";
          const bt2Error = this.validateVideohaoBt2(shortTitle);
          if (bt2Error) {
            console.warn(
              `文件 ${fileRow.fileName}: ${bt2Error}，将跳过视频号短标题`
            );
            return "";
          }
          return shortTitle;
        })();

        for (let pIdx = 0; pIdx < platforms.length; pIdx++) {
          const p = platforms[pIdx];
          const partition = buildAccountPartitionOf(p, p.pt);
          const taskId = Date.now() + Math.random();
          const shouldShow = this.thisShow;
          const shouldCloseWindowAfterPublish = shouldShow
            ? this.closeWindow
            : true;
          // Excel 显式声明（含 none / 无标注）永远优先于默认值与界面默认选项，与 CLI 保持一致（#11）
          const rowExplicitCs =
            fileRow && fileRow.creativeStatement != null
              ? String(fileRow.creativeStatement).trim()
              : "";
          const creativeStatement = rowExplicitCs
            ? resolveCreativeStatementForPlatform(rowExplicitCs, p.pt)
            : this.getPlatformStatement(p.id, p.pt);
          const dirCollection = this.resolvePlatformCollectionValue(
            p.id,
            p.pt,
            fileRow && fileRow.collection
          );
          const dirDySyncToutiao =
            String(p.pt || "").includes("抖音") &&
            Boolean(this.form && this.form.dySyncToutiao === true);
          const dirCoverPathH = String(fileRow.coverHResolved || "").trim();
          const dirPublishOptions = {
            ...(dirCollection ? { collection: dirCollection } : {}),
            ...(dirDySyncToutiao ? { dySyncToutiao: true } : {}),
            ...(dirCoverPathH ? { coverPathH: dirCoverPathH } : {}),
          };
          const effectiveMode = resolveEffectivePublishMode(isDraftMode, p);

          const dirRuled = safeApplyPlatformRules(
            p.pt,
            {
              title: bt1,
              description,
              shortTitle: bt2FilledForVideohao,
              tags: tagList,
              titleByPlatform: fileRow.titleByPlatform || {},
              descByPlatform: fileRow.descByPlatform || {},
            },
            { log: true }
          );
          const finalTitle = dirRuled ? dirRuled.title : bt1;
          const finalDescription = dirRuled
            ? dirRuled.bodyDescription
            : description;
          const finalTags = dirRuled ? dirRuled.tags : tagList;
          const dirRuleAdjustments =
            dirRuled && dirRuled.adjusted ? dirRuled.adjustments : [];
          const dirRuleSummary =
            dirRuled && dirRuled.adjusted ? dirRuled.summary : "";
          const dirAppliedSnapshot = safeCreateAppliedRuleSnapshot(dirRuled);

          // Format bq for this platform
          const hashtagPlatforms = new Set(["视频号", "抖音", "快手"]);
          let bq;
          if (hashtagPlatforms.has(p.pt)) {
            bq = finalTags
              .map((t) => (t.startsWith("#") ? t : "#" + t))
              .join(" ");
          } else {
            bq = finalTags.map((t) => t.replace(/^#/, "")).join(",");
          }
          const metadata = normalizeVideoMetadata(
            {
              title: finalTitle,
              description: finalDescription,
              shortTitle: bt2FilledForVideohao,
              tags: finalTags,
            },
            p.pt
          );

          const dirPlanItem = dirThrottleDecision.itemsByKey.get(
            `dir:${rIdx}:${pIdx}:${p.id}`
          );
          const dirReservationId =
            !effectiveMode.publishToDraft &&
            dirPlanItem &&
            dirPlanItem.reservationId
              ? dirPlanItem.reservationId
              : null;
          const shouldScheduleDir =
            !effectiveMode.publishToDraft &&
            (dirPlanItem
              ? Boolean(dirPlanItem.scheduled)
              : this.scheduledPublish);

          if (shouldScheduleDir) {
            const itemScheduledAtMs =
              dirPlanItem && dirPlanItem.scheduled
                ? dirPlanItem.plannedAtMs
                : scheduledAtMs;
            const itemScheduledAtText =
              dirPlanItem && dirPlanItem.scheduled
                ? dirPlanItem.publishAt
                : scheduledAtText;
            const itemThrottleReason =
              (!dirThrottleDecision.noThrottle &&
                dirPlanItem &&
                dirPlanItem.reason) ||
              "";
            scheduledWriteTasks.push(
              this.writeScheduledPublishRecord(
                {
                  bookName,
                  textOtherName,
                  textType: "local",
                  pt: p.pt,
                  selectedFile,
                  bt: metadata.title,
                  title: metadata.title,
                  description: metadata.description,
                  shortTitle: metadata.shortTitle,
                  tags: metadata.tags,
                  ...metadata.legacy,
                  bq,
                  creativeStatement,
                  coverPath: fileRow.coverResolved || "",
                  ...(dirCoverPathH ? { coverPathH: dirCoverPathH } : {}),
                  ...(dirRuleAdjustments.length > 0
                    ? {
                        ruleAdjustments: dirRuleAdjustments,
                        ruleAdjustmentsSummary: dirRuleSummary,
                      }
                    : {}),
                  noDownload: this.form.noDownload === true,
                  ...(Object.keys(dirPublishOptions).length > 0
                    ? { publishOptions: dirPublishOptions }
                    : {}),
                  filePath,
                  useragent: this.ptConfig[p.pt].useragent,
                  phone: p.phone,
                  group: p.group,
                  accountName: p.accountName,
                  accountKey: p.accountKey,
                  partition,
                  url: this.ptConfig[p.pt].listIndex,
                  uploadUrl: this.ptConfig[p.pt].upload,
                  date: currentDate,
                  scheduledTask: true,
                  ...(dirDupDecision.allowDuplicate ? { allowDuplicate: true } : {}),
                  ...(itemThrottleReason
                    ? { throttleReason: itemThrottleReason }
                    : {}),
                  scheduledPublishAt: itemScheduledAtMs,
                  scheduledPublishAtText: itemScheduledAtText,
                  useRealBrowser: Boolean(p.useRealBrowser),
                  publishMode: effectiveMode.publishMode,
                  publishToDraft: effectiveMode.publishToDraft,
                  publishAttemptCount: 1,
                  republishCount: 0,
                  publishSuccessCount: 0,
                  publishFailCount: 0,
                  publishStatus: "scheduled",
                  lastPublishMessage: itemThrottleReason
                    ? `等待定时发布（${itemThrottleReason}）`
                    : "等待定时发布",
                  lastPublishAt: Date.now(),
                },
                dirReservationId
              )
            );
            continue;
          }

          let pushRes;
          let persistedRecordId = null;
          try {
            pushRes = await dataRequest({
              type: "add",
              fileName: "pushData",
              item: {
                bookName,
                textOtherName,
                textType: "local",
                pt: p.pt,
                selectedFile,
                bt: metadata.title,
                title: metadata.title,
                description: metadata.description,
                shortTitle: metadata.shortTitle,
                tags: metadata.tags,
                ...metadata.legacy,
                bq,
                creativeStatement,
                coverPath: fileRow.coverResolved || "",
                ...(dirCoverPathH ? { coverPathH: dirCoverPathH } : {}),
                ...(dirRuleAdjustments.length > 0
                  ? {
                      ruleAdjustments: dirRuleAdjustments,
                      ruleAdjustmentsSummary: dirRuleSummary,
                    }
                  : {}),
                noDownload: this.form.noDownload === true,
                ...(Object.keys(dirPublishOptions).length > 0
                  ? { publishOptions: dirPublishOptions }
                  : {}),
                filePath,
                useragent: this.ptConfig[p.pt].useragent,
                phone: p.phone,
                group: p.group,
                accountName: p.accountName,
                accountKey: p.accountKey,
                partition,
                url: this.ptConfig[p.pt].listIndex,
                uploadUrl: this.ptConfig[p.pt].upload,
                date: currentDate,
                useRealBrowser: Boolean(p.useRealBrowser),
                publishMode: effectiveMode.publishMode,
                publishToDraft: effectiveMode.publishToDraft,
                // 重发开始即清掉上次失败截图，避免显示的是上一轮的旧画面
                failScreenshot: "",
                publishAttemptCount: 1,
                republishCount: 0,
                publishSuccessCount: 0,
                publishFailCount: 0,
                publishStatus: effectiveMode.publishToDraft
                  ? "drafting"
                  : "publishing",
                lastPublishMessage: effectiveMode.publishToDraft
                  ? "等待保存草稿结果"
                  : "等待发布结果",
                lastPublishAt: Date.now(),
              },
            });
            if (pushRes && pushRes.success && Array.isArray(pushRes.data)) {
              const found = [...pushRes.data]
                .reverse()
                .find(
                  (it) =>
                    it.textOtherName === textOtherName &&
                    it.pt === p.pt &&
                    it.selectedFile === selectedFile &&
                    String(it.partition || "") === String(partition || "")
                );
              if (found) persistedRecordId = found.id;
            }
          } catch (e) {
            pushRes = { success: false, message: (e && e.message) || String(e) };
          }
          if (pushRes && pushRes.success === false) {
            if (dirReservationId) {
              await this.releaseThrottleReservations([dirReservationId]);
            }
            writeErrors.push(
              `${fileRow.fileName}（${p.pt}）写入发布记录失败：${
                pushRes.message || "未知错误"
              }`
            );
            continue;
          }
          if (
            dirReservationId &&
            ipcRenderer &&
            typeof ipcRenderer.invoke === "function"
          ) {
            try {
              await ipcRenderer.invoke("publish-throttle:confirm-reservation", {
                reservationId: dirReservationId,
                status: "publishing",
                recordId: persistedRecordId,
                ts: Date.now(),
                isScheduled: false,
              });
            } catch (_) {}
          }

          const publishPayload = applyXhsConservativePublishOptions({
            ...p,
            taskId,
            allowDuplicate: true,
            ...(persistedRecordId != null
              ? { recordId: persistedRecordId }
              : {}),
            ...(dirReservationId
              ? { throttleReservationId: dirReservationId }
              : {}),
            bookName,
            textType: "local",
            data: {
              textOtherName,
              title: metadata.title,
              description: metadata.description,
              shortTitle: metadata.shortTitle,
              tags: metadata.tags,
              ...metadata.legacy,
              bq,
              creativeStatement,
              coverPath: fileRow.coverResolved || "",
              ...(dirCoverPathH ? { coverPathH: dirCoverPathH } : {}),
              ...(dirAppliedSnapshot
                ? { platformRulesApplied: dirAppliedSnapshot }
                : {}),
              ...(dirRuleAdjustments.length > 0
                ? {
                    ruleAdjustments: dirRuleAdjustments,
                    ruleAdjustmentsSummary: dirRuleSummary,
                  }
                : {}),
              noDownload: this.form.noDownload === true,
            },
            textOtherName,
            selectedFile,
            publishMode: effectiveMode.publishMode,
            publishToDraft: effectiveMode.publishToDraft,
            ...(Object.keys(dirPublishOptions).length > 0
              ? { publishOptions: dirPublishOptions }
              : {}),
            url: this.ptConfig[p.pt].upload,
            show: shouldShow,
            closeWindowAfterPublish: shouldCloseWindowAfterPublish,
            useragent: this.ptConfig[p.pt].useragent,
            partition,
            filePath,
            date: currentDate,
          });
          ipcRenderer.send(
            "puppeteerFile",
            JSON.parse(JSON.stringify(publishPayload))
          );

          submitted++;
          if (isXhsPlatform(p.pt)) {
            await sleep(getXhsPlatformStaggerDelayMs());
          } else if (p.pt === "视频号") {
            await sleep(4000);
          }
          if (effectiveMode.publishToDraft) draftSubmitted++;
        }
      }

      if (scheduledWriteTasks.length > 0) {
        const writeResults = await Promise.all(scheduledWriteTasks);
        for (const r of writeResults) {
          if (r && (r.ok === true || r.success === true)) {
            submitted++;
            scheduledSubmitted++;
          } else {
            writeErrors.push(
              (r && (r.message || r.error)) || "写入定时发布记录失败"
            );
          }
        }
        if (scheduledSubmitted > 0) {
          ipcRenderer.send("scheduledPublish:refresh");
        }
      }

      if (writeErrors.length > 0) {
        this.$message.error(writeErrors.join("；"));
      }
      if (submitted === 0) {
        if (writeErrors.length === 0) {
          this.$message.warning("没有提交新的发布任务");
        }
        return;
      }
      let successMessage = `已提交 ${submitted} 个目录批量发布任务`;
      if (draftSubmitted === submitted) {
        successMessage = `已提交 ${submitted} 个目录批量保存草稿任务`;
      } else if (scheduledSubmitted === submitted) {
        successMessage = `已创建 ${submitted} 个目录批量定时发布任务`;
      } else if (scheduledSubmitted > 0) {
        const immediateCount = submitted - scheduledSubmitted;
        successMessage = `已提交 ${immediateCount} 个目录批量立即发布，${scheduledSubmitted} 个已按节流排期定时发布`;
      }
      this.$message.success(successMessage);
      this.attrsVisible = false;
      this.platformVisible = false;
      this.dirBatchFiles = [];
      this.dirPath = "";
      this.dirXlsxRows = [];
      this.$emit("published");
    },
  },
};
</script>

<style scoped>
.ai-field-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.ai-field-row > :first-child {
  flex: 1;
  min-width: 0;
}
.file-field-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.file-thumb {
  flex: 0 0 112px;
  width: 112px;
  height: 112px;
  border: 1px solid #dcdfe6;
  border-radius: 4px;
  background: #fafafa;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.file-thumb:hover {
  border-color: #409eff;
}
.file-thumb .el-icon-upload {
  font-size: 48px;
  color: #c0c4cc;
}
.file-thumb-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #000;
  pointer-events: none;
}
.file-meta {
  min-width: 0;
}
.file-name {
  font-size: 14px;
  color: #303133;
  word-break: break-all;
}
.file-tip {
  margin-top: 4px;
  font-size: 12px;
  color: #909399;
}
.file-actions {
  margin-top: 4px;
}
.file-actions .el-button {
  padding: 0;
  margin-right: 12px;
}
.cover-field-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.cover-name {
  font-size: 13px;
  color: #606266;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.meta-form {
  margin-bottom: 8px;
}
.bt2-tip {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: #909399;
}
.video-form {
  margin-bottom: 16px;
}
.platform-tree-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 12px;
}
.batch-statement-wrap {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.batch-statement-label {
  font-size: 13px;
  color: #606266;
}
.batch-statement-select {
  width: 200px;
}
.batch-collection-wrap {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.batch-collection-input {
  width: 200px;
}
.custom-tree-node {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
}
.custom-tree-node.platform-leaf-node {
  flex-direction: column;
  align-items: stretch;
  width: 180px;
  min-width: 180px;
  box-sizing: border-box;
}
.platform-leaf-main {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.platform-leaf-name {
  margin-right: 4px;
}
.platform-leaf-proxy {
  margin-right: 4px;
  font-size: 12px;
  color: #409eff;
}
.platform-statement-row {
  width: 100%;
  margin-top: 6px;
}
.platform-statement-select {
  width: 100%;
}
.attrs-link-cell {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.attrs-link-type {
  width: 110px;
}
.attrs-product-select {
  width: 220px;
}
.attrs-entity-sub {
  margin-left: 8px;
  color: #909399;
  font-size: 12px;
}
.attrs-product-id {
  width: 160px;
}
.attrs-link-value {
  width: 220px;
  margin-left: 6px;
}
.attrs-unsupported {
  color: #909399;
  font-size: 12px;
}
.platform-title-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 12px;
}
.platform-title-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.platform-title-label {
  font-size: 12px;
  color: #606266;
  line-height: 1.4;
}
.platform-title-label small {
  color: #909399;
  font-size: 11px;
}
.rule-precheck-alert {
  margin-bottom: 12px;
}
.rule-precheck-list {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.5;
}
.rule-precheck-item {
  word-break: break-all;
}
.attrs-title-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}
.attrs-truncate-tag {
  flex: 0 0 auto;
}
:deep(.platform-statement-select .el-input) {
  width: 100%;
}
:deep(.platform-statement-select .el-input__inner) {
  overflow: hidden;
  text-overflow: ellipsis;
}
.login-ok {
  padding-left: 10px;
  cursor: pointer;
}
:deep(.el-dialog__body) {
  padding-top: 10px;
}
:deep(.el-tree-node__content) {
  height: auto;
  min-height: 26px;
  align-items: flex-start;
  padding-top: 3px;
  padding-bottom: 3px;
}
:deep(.el-tree-node__content > .el-checkbox) {
  margin-top: 2px;
}
:deep(.el-tree-node.is-expanded > .el-tree-node__children) {
  display: flex;
  flex-wrap: wrap;
}
</style>

<style>
.statement-select-dropdown {
  min-width: 260px !important;
}
.statement-select-dropdown .el-select-dropdown__item {
  height: auto;
  line-height: 1.45;
  padding-top: 8px;
  padding-bottom: 8px;
  white-space: normal;
}
</style>
