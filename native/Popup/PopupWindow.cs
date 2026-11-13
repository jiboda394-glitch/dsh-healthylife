using System;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Shapes;
using System.Windows.Threading;
using ShapePath = System.Windows.Shapes.Path;

namespace HealthyLife.Popup
{
    internal sealed class PopupWindow : Window
    {
        private readonly PopupOptions options;
        private readonly DispatcherTimer timer;
        private readonly Palette palette;
        private readonly bool countdownMode;

        private ShapePath ringPath;
        private TextBlock ringNumber;
        private TextBlock errorText;
        private Button cancelButton;
        private bool closing;
        private TextBlock headline;
        private int lastReminderMinutes = -1;

        // Localhost only: a system proxy (WPAD auto-detect) can stall the first request
        // for seconds on this machine, which is exactly what made the buttons feel stuck.
        // The popup may run under a restricted token, so the first writable candidate wins:
        // a silently swallowed write would make every future bug report undiagnosable.
        private static string logPath;

        private static string[] LogCandidates()
        {
            var list = new System.Collections.Generic.List<string>();
            try
            {
                var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                if (!string.IsNullOrEmpty(local)) list.Add(System.IO.Path.Combine(local, "healthylife", "popup.log"));
            }
            catch { }
            try
            {
                var temp = System.IO.Path.GetTempPath();
                if (!string.IsNullOrEmpty(temp)) list.Add(System.IO.Path.Combine(temp, "healthylife-popup.log"));
            }
            catch { }
            try
            {
                list.Add(System.IO.Path.Combine(AppContext.BaseDirectory, "popup.log"));
            }
            catch { }
            return list.ToArray();
        }

        private static void Log(string message)
        {
            var candidates = logPath == null ? LogCandidates() : new[] { logPath };
            foreach (var candidate in candidates)
            {
                try
                {
                    var folder = System.IO.Path.GetDirectoryName(candidate);
                    if (!string.IsNullOrEmpty(folder)) System.IO.Directory.CreateDirectory(folder);
                    System.IO.File.AppendAllText(candidate, DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
                    logPath = candidate;
                    return;
                }
                catch
                {
                    /* logging must never break the popup */
                }
            }
        }

        // Localhost only: a system proxy (WPAD auto-detect) can stall the first request
        // for seconds on this machine, which is exactly what made the buttons feel stuck.
        private static readonly HttpClient Http = new HttpClient(new HttpClientHandler { UseProxy = false })
        {
            Timeout = TimeSpan.FromSeconds(6)
        };

        public PopupWindow(PopupOptions options)
        {
            this.options = options;
            this.palette = Palette.For(options.Dark);
            this.countdownMode = string.Equals(options.Phase, "countdown", StringComparison.OrdinalIgnoreCase);

            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ResizeMode = ResizeMode.NoResize;
            ShowInTaskbar = false;
            Topmost = true;
            WindowStartupLocation = WindowStartupLocation.Manual;
            SizeToContent = SizeToContent.WidthAndHeight;
            ShowActivated = true;
            FontFamily = new FontFamily("Microsoft YaHei UI, Segoe UI");

            Content = BuildContent();
            Log($"start phase={options.Phase}");
            Loaded += (_, _) => PlaceWindow();
            timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(countdownMode ? 120 : 1000) };
            timer.Tick += (_, _) => Tick();
        }

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            Log("shown");
            timer.Start();
            Tick();
        }

        private void PlaceWindow()
        {
            var area = SystemParameters.WorkArea;
            if (countdownMode)
            {
                Left = area.Left + (area.Width - ActualWidth) / 2;
                Top = area.Top + (area.Height - ActualHeight) / 2;
            }
            else
            {
                Left = area.Right - ActualWidth - 28;
                Top = area.Bottom - ActualHeight - 28;
            }
        }

        private UIElement BuildContent()
        {
            var card = new Border
            {
                CornerRadius = new CornerRadius(20),
                Background = palette.Surface,
                BorderBrush = palette.Border,
                BorderThickness = new Thickness(1),
                Padding = countdownMode ? new Thickness(30, 26, 30, 22) : new Thickness(22, 18, 22, 18),
                Effect = new DropShadowEffect
                {
                    BlurRadius = 40,
                    ShadowDepth = 8,
                    Direction = 270,
                    Opacity = 0.35,
                    Color = Colors.Black
                }
            };
            card.MouseLeftButtonDown += (_, eventArgs) =>
            {
                if (eventArgs.ButtonState == MouseButtonState.Pressed) { }
            };

            var stack = new StackPanel { Width = countdownMode ? 400 : 380 };
            stack.Children.Add(BuildHeader());

            if (countdownMode)
            {
                stack.Children.Add(BuildRing());
                stack.Children.Add(Text(
                    $"{DayPrefix()}{options.WindowStart} – {options.WindowEnd} 为宵禁时段，期间开机将停留在锁屏界面。",
                    12.5, palette.Muted, new Thickness(0, 2, 0, 18), TextAlignment.Center));
            }
            else
            {
                stack.Children.Add(Text(
                    $"{DayPrefix()}{options.WindowStart} 将自动关机，现在可以保存手头的工作。",
                    13, palette.Muted, new Thickness(0, 8, 0, 16), TextAlignment.Left));
            }

            errorText = Text("", 12, palette.Danger, new Thickness(0, 10, 0, 0), TextAlignment.Center);
            stack.Children.Add(errorText);

            var actions = new StackPanel { Orientation = Orientation.Vertical, Margin = new Thickness(0, 10, 0, 0) };
            if (countdownMode)
            {
                actions.Children.Add(MakeButton("立即关机", palette.Danger, Brushes.White, async () => await Act("shutdown"), 42));
                cancelButton = MakeButton(CancelLabel(), palette.SurfaceAlt, palette.Text, async () => await Act("cancel"), 42);
                actions.Children.Add(cancelButton);
            }
            else
            {
                var row = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
                row.Children.Add(MakeButton("知道了", palette.SurfaceAlt, palette.Text, () =>
                {
                    Log("click-dismiss");
                    closing = true;
                    Close();
                    Log("close-returned");
                    return Task.CompletedTask;
                }, 34, 96, new Thickness(0, 0, 8, 0)));
                row.Children.Add(MakeButton("立即关机", palette.Danger, Brushes.White, async () => await Act("shutdown"), 34, 110, new Thickness(0, 0, 0, 0)));
                actions.Children.Add(row);
            }
            stack.Children.Add(actions);

            if (countdownMode)
            {
                stack.Children.Add(Text(
                    "不做选择将在倒计时结束后关机",
                    11.5, palette.Muted, new Thickness(0, 14, 0, 0), TextAlignment.Center));
            }

            card.Child = stack;
            return card;
        }

        private string CancelLabel()
            => options.QuotaLeft > 0 ? $"取消本次（今晚还剩 {options.QuotaLeft} 次）" : "取消次数已用完";

        private UIElement BuildHeader()
        {
            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, countdownMode ? 10 : 0) };

            var icon = new Border
            {
                Width = 40,
                Height = 40,
                CornerRadius = new CornerRadius(12),
                Background = palette.AccentSoft,
                Child = new TextBlock
                {
                    Text = "☾",
                    FontSize = 20,
                    Foreground = palette.Accent,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center
                }
            };
            row.Children.Add(icon);

            var texts = new StackPanel { Margin = new Thickness(12, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            texts.Children.Add(new TextBlock
            {
                Text = (countdownMode ? "CURFEW" : "REMINDER") + (options.Preview ? " · 预览" : ""),
                FontSize = 10.5,
                Foreground = palette.Muted,
                FontWeight = FontWeights.SemiBold
            });
            headline = new TextBlock
            {
                Text = countdownMode ? "到点了，该休息了" : ReminderText(ReminderMinutes()),
                FontSize = countdownMode ? 17 : 15,
                FontWeight = FontWeights.SemiBold,
                Foreground = palette.Text
            };
            lastReminderMinutes = ReminderMinutes();
            texts.Children.Add(headline);
            row.Children.Add(texts);
            return row;
        }

        private UIElement BuildRing()
        {
            var size = 200.0;
            var canvas = new Canvas { Width = size, Height = size, HorizontalAlignment = HorizontalAlignment.Center, Margin = new Thickness(0, 6, 0, 6) };
            var center = new Point(size / 2, size / 2);
            var radius = 86.0;

            canvas.Children.Add(new Ellipse
            {
                Width = radius * 2,
                Height = radius * 2,
                Stroke = palette.Border,
                StrokeThickness = 8,
                Margin = new Thickness(center.X - radius, center.Y - radius, 0, 0)
            });

            ringPath = new ShapePath
            {
                Stroke = palette.Accent,
                StrokeThickness = 8,
                StrokeStartLineCap = PenLineCap.Round,
                StrokeEndLineCap = PenLineCap.Round
            };
            canvas.Children.Add(ringPath);

            ringNumber = new TextBlock
            {
                Text = "30",
                FontSize = 46,
                FontWeight = FontWeights.Bold,
                Foreground = palette.Text,
                TextAlignment = TextAlignment.Center,
                Width = size
            };
            Canvas.SetTop(ringNumber, center.Y - 40);
            canvas.Children.Add(ringNumber);

            var unit = new TextBlock
            {
                Text = "秒后自动关机",
                FontSize = 11.5,
                Foreground = palette.Muted,
                TextAlignment = TextAlignment.Center,
                Width = size
            };
            Canvas.SetTop(unit, center.Y + 14);
            canvas.Children.Add(unit);

            return canvas;
        }

        private TextBlock Text(string text, double size, Brush brush, Thickness margin, TextAlignment align)
        {
            return new TextBlock
            {
                Text = text,
                FontSize = size,
                Foreground = brush,
                Margin = margin,
                TextAlignment = align,
                TextWrapping = TextWrapping.Wrap
            };
        }

        private Button MakeButton(string text, Brush background, Brush foreground, Func<Task> onClick, double height, double minWidth = 0, Thickness margin = default)
        {
            var button = new Button
            {
                Content = new TextBlock
                {
                    Text = text,
                    FontSize = 13.5,
                    Foreground = foreground,
                    HorizontalAlignment = HorizontalAlignment.Center,
                    VerticalAlignment = VerticalAlignment.Center,
                    TextAlignment = TextAlignment.Center
                },
                Height = height,
                MinWidth = minWidth,
                Margin = margin,
                Background = background,
                BorderThickness = new Thickness(0),
                Cursor = Cursors.Hand,
                Focusable = false,
                HorizontalContentAlignment = HorizontalAlignment.Center,
                VerticalContentAlignment = VerticalAlignment.Center
            };

            var template = new ControlTemplate(typeof(Button));
            var shell = new FrameworkElementFactory(typeof(Border));
            shell.SetValue(Border.CornerRadiusProperty, new CornerRadius(11));
            shell.SetValue(Border.BackgroundProperty, new TemplateBindingExtension(Button.BackgroundProperty));
            shell.SetValue(Border.PaddingProperty, new Thickness(14, 0, 14, 0));
            var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            shell.AppendChild(presenter);
            template.VisualTree = shell;
            button.Template = template;

            button.MouseEnter += (_, _) => button.Opacity = 0.88;
            button.MouseLeave += (_, _) => button.Opacity = 1;
            button.Click += async (_, _) => { await onClick(); };
            return button;
        }

        private async Task TryDismiss()
        {
            try
            {
                using var content = new StringContent("{}", Encoding.UTF8, "application/json");
                using var response = await Http.PostAsync($"{options.Api}/dismiss", content);
            }
            catch
            {
                /* dismissing must always close the window */
            }
        }

        private async Task Act(string action)
        {
            try
            {
                var payload = action == "cancel" ? "{}" : "{}";
                using var content = new StringContent(payload, Encoding.UTF8, "application/json");
                using var response = await Http.PostAsync($"{options.Api}/{action}", content);
                var body = await response.Content.ReadAsStringAsync();
                using var document = JsonDocument.Parse(body);
                var root = document.RootElement;
                var ok = root.TryGetProperty("ok", out var okValue) && okValue.ValueKind == JsonValueKind.True;
                if (!ok)
                {
                    var message = root.TryGetProperty("error", out var errorValue) && errorValue.ValueKind == JsonValueKind.String
                        ? errorValue.GetString()
                        : "操作失败";
                    if (errorText != null) errorText.Text = message;
                    return;
                }
                closing = true;
                Close();
            }
            catch (Exception error)
            {
                if (errorText != null) errorText.Text = "无法连接插件：" + error.Message;
            }
        }

        private void Tick()
        {
            if (!countdownMode)
            {
                UpdateReminder();
                return;
            }
            var remaining = options.Deadline - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (remaining <= 0)
            {
                timer.Stop();
                _ = ShutdownAndClose();
                return;
            }
            var total = Math.Max(1, options.CountdownSeconds * 1000);
            var progress = Math.Min(1, Math.Max(0, (double)remaining / total));
            if (ringNumber != null) ringNumber.Text = Math.Ceiling(remaining / 1000.0).ToString("0");
            if (ringPath != null) ringPath.Data = Arc(200, 86, progress);
        }

        private string DayPrefix() => string.IsNullOrEmpty(options.WindowDay) ? "" : options.WindowDay + " ";

        private static string ReminderText(int minutes)
        {
            if (minutes >= 60)
            {
                var hours = minutes / 60;
                var rest = minutes % 60;
                return rest == 0 ? $"距离宵禁还有 {hours} 小时" : $"距离宵禁还有 {hours} 小时 {rest} 分";
            }
            return $"距离宵禁还有 {minutes} 分钟";
        }

        private int ReminderMinutes()
        {
            if (options.TargetAt > 0)
            {
                var left = options.TargetAt - DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                return (int)Math.Max(1, Math.Ceiling(left / 60000.0));
            }
            return Math.Max(1, options.MinutesLeft);
        }

        /// <summary>提醒弹窗会停留最多一小时，倒计时按分钟刷新。</summary>
        private void UpdateReminder()
        {
            if (headline == null || countdownMode) return;
            var minutes = ReminderMinutes();
            if (minutes == lastReminderMinutes) return;
            lastReminderMinutes = minutes;
            Log($"reminder minutes={minutes} targetAt={options.TargetAt}");
            headline.Text = ReminderText(minutes);
        }

        private async Task ShutdownAndClose()
        {
            try
            {
                using var content = new StringContent("{}", Encoding.UTF8, "application/json");
                using var response = await Http.PostAsync($"{options.Api}/shutdown", content);
            }
            catch
            {
                /* the host also fires the shutdown when the deadline passes */
            }
            closing = true;
            Close();
        }

        private static Geometry Arc(double size, double radius, double progress)
        {
            var center = new Point(size / 2, size / 2);
            var sweep = Math.Min(359.99, 360 * progress);
            var start = OnCircle(center, radius, -90);
            var end = OnCircle(center, radius, -90 + sweep);
            var figure = new PathFigure { StartPoint = start, IsClosed = false };
            figure.Segments.Add(new ArcSegment
            {
                Point = end,
                Size = new Size(radius, radius),
                IsLargeArc = sweep > 180,
                SweepDirection = SweepDirection.Clockwise
            });
            var geometry = new PathGeometry();
            geometry.Figures.Add(figure);
            return geometry;
        }

        private static Point OnCircle(Point center, double radius, double degrees)
        {
            var radians = degrees * Math.PI / 180.0;
            return new Point(center.X + radius * Math.Cos(radians), center.Y + radius * Math.Sin(radians));
        }

        protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
        {
            Log($"onclosing allowed={closing}");
            if (!closing)
            {
                e.Cancel = true;
                return;
            }
            timer.Stop();
            base.OnClosing(e);
        }

        protected override void OnClosed(EventArgs e)
        {
            Log("closed");
            base.OnClosed(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.Key == Key.Escape) e.Handled = true;
            base.OnKeyDown(e);
        }
    }

    internal sealed class Palette
    {
        public Brush Surface;
        public Brush SurfaceAlt;
        public Brush Border;
        public Brush Text;
        public Brush Muted;
        public Brush Accent;
        public Brush AccentSoft;
        public Brush Danger;

        public static Palette For(bool dark)
        {
            return dark
                ? new Palette
                {
                    Surface = Brush("#1F2126"),
                    SurfaceAlt = Brush("#2A2D34"),
                    Border = Brush("#34373F"),
                    Text = Brush("#ECEDEE"),
                    Muted = Brush("#9BA1A9"),
                    Accent = Brush("#4D6BFE"),
                    AccentSoft = Brush("#252C46"),
                    Danger = Brush("#E5484D")
                }
                : new Palette
                {
                    Surface = Brush("#FFFFFF"),
                    SurfaceAlt = Brush("#F2F3F5"),
                    Border = Brush("#E5E6EB"),
                    Text = Brush("#1D2129"),
                    Muted = Brush("#6B7280"),
                    Accent = Brush("#4D6BFE"),
                    AccentSoft = Brush("#EEF1FF"),
                    Danger = Brush("#E5484D")
                };
        }

        private static Brush Brush(string hex)
        {
            var brush = new SolidColorBrush((Color)ColorConverter.ConvertFromString(hex));
            brush.Freeze();
            return brush;
        }
    }
}
